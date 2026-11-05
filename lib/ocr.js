'use strict';
/**
 * 图纸 OCR：优先使用本机 RapidOCR 中文模型，Windows.Media.Ocr 兜底。
 * 不走任何外部服务。
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PY_SCRIPT = `
import json
import os

out = os.environ['QMS_OUT']
try:
    from rapidocr_onnxruntime import RapidOCR
    result, _ = RapidOCR()(os.environ['QMS_IMG'])
    words = []
    for box, text, score in result or []:
        if not text or float(score) < 0.35:
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        words.append({
            't': str(text).strip(),
            'x': int(min(xs)),
            'y': int(min(ys)),
            'w': int(max(xs) - min(xs)),
            'h': int(max(ys) - min(ys)),
            'score': float(score),
        })
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(words, handle, ensure_ascii=False)
except Exception as error:
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump({'error': str(error)}, handle, ensure_ascii=False)
`;

const PS_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:QMS_IMG)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if (-not $engine) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('OCR 引擎不可用（缺少中文语言包）'))
    Write-Output ('{"error":"' + $encoded + '"}')
    exit 0
  }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $words = @()
  foreach ($line in $result.Lines) {
    foreach ($w in $line.Words) {
      $words += [pscustomobject]@{
        t = $w.Text; x = [int]$w.BoundingRect.X; y = [int]$w.BoundingRect.Y
        w = [int]$w.BoundingRect.Width; h = [int]$w.BoundingRect.Height
      }
    }
  }
  $json = ($words | ConvertTo-Json -Compress -Depth 3)
  [System.IO.File]::WriteAllText($env:QMS_OUT, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  $message = $e.ToString()
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
  $err = '{"error":"' + $encoded + '"}'
  [System.IO.File]::WriteAllText($env:QMS_OUT, $err, (New-Object System.Text.UTF8Encoding($false)))
}
`;

function runRapidOCR(imagePath) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const script = path.join(os.tmpdir(), `qms-rapidocr-${id}.py`);
    const out = path.join(os.tmpdir(), `qms-rapidocr-${id}.json`);
    fs.writeFileSync(script, PY_SCRIPT, 'utf8');
    const env = { ...process.env, QMS_IMG: imagePath, QMS_OUT: out, PYTHONIOENCODING: 'utf-8' };
    execFile('python', ['-X', 'utf8', script], { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let raw = '';
        try { raw = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : ''; } catch (e) { raw = ''; }
        try { fs.unlinkSync(script); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
        if (!raw) {
          return reject(new Error('RapidOCR 调用失败：' + String(stderr || (err && err.message) || '无输出').slice(0, 200)));
        }
        let data;
        try { data = JSON.parse(raw); } catch (e) { return reject(new Error('RapidOCR 输出无法解析')); }
        if (data && data.error) return reject(new Error(data.error));
        resolve(Array.isArray(data) ? data : []);
      });
  });
}

function runWindowsOCR(imagePath) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const script = path.join(os.tmpdir(), `qms-ocr-${id}.ps1`);
    const out = path.join(os.tmpdir(), `qms-ocr-${id}.json`);
    fs.writeFileSync(script, PS_SCRIPT, 'utf8');
    const env = { ...process.env, QMS_IMG: imagePath, QMS_OUT: out };
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let raw = '';
        try { raw = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : ''; } catch (e) { raw = ''; }
        try { fs.unlinkSync(script); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
        if (!raw) {
          return reject(new Error('OCR 调用失败：' + String(stderr || (err && err.message) || '无输出').slice(0, 200)));
        }
        let data;
        try { data = JSON.parse(raw); } catch (e) { return reject(new Error('OCR 输出无法解析')); }
        if (data && data.error) {
          let message = data.error;
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(message)) {
            try { message = Buffer.from(message, 'base64').toString('utf8'); } catch (e) { /* 兼容旧错误格式 */ }
          }
          return reject(new Error(message));
        }
        resolve(Array.isArray(data) ? data : [data]);
      });
  });
}

async function runOCR(imagePath) {
  const absolutePath = path.resolve(String(imagePath || ''));
  let rapidError = null;
  try {
    const words = await runRapidOCR(absolutePath);
    if (words.length) return words;
  } catch (error) {
    rapidError = error;
  }
  try {
    return await runWindowsOCR(absolutePath);
  } catch (error) {
    const detail = rapidError ? `RapidOCR：${rapidError.message}；Windows OCR：${error.message}` : error.message;
    throw new Error(detail);
  }
}

/* ------------------------------------------------------------------ 切词 */
// 电阻器/被动元件常用结构词（可扩展）
const LEXICON = [
  '白瓷棒', '瓷棒', '瓷管', '瓷片', '基体', '陶瓷基体', '基板', '骨架', '磁芯',
  '膜层', '电阻膜', '膜厚', '镀层', '涂层', '漆层', '清漆', '绝缘漆', '缓冲层',
  '塑封层', '包封层', '包封', '外壳', '壳体', '保护层', '阻燃层',
  '引线帽', '端帽', '端电极', '电极', '引线', '引脚', '焊点', '焊料', '端子',
  '螺旋槽', '刻槽', '槽', '螺纹', '标识', '打标', '色环', '涂层边缘',
  '内电极', '外电极', '镀锡层', '镍层', '银层', '锡层',
];

const SUFFIX = ['层', '帽', '槽', '棒', '膜', '管', '片', '壳', '板', '环', '线', '极', '座', '钉', '簧', '胶', '漆', '网', '架', '块', '体'];

const clean = t => String(t || '').replace(/[\s\u3000]/g, '').replace(/[.,;:!?'"()\[\]{}<>]/g, '');

/** 用词典 + 后缀规则把一段粘连文字切成多个结构词 */
function segmentByLexicon(text) {
  const s = clean(text);
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let hit = null;
    // 1) 词典最长匹配
    for (let len = Math.min(6, s.length - i); len >= 2; len--) {
      const sub = s.slice(i, i + len);
      if (LEXICON.includes(sub)) { hit = sub; break; }
    }
    // 2) 后缀规则：X层 / X帽 / X槽 …（X 取 1–3 字）
    if (!hit) {
      for (let len = 4; len >= 2; len--) {
        const sub = s.slice(i, i + len);
        if (sub.length >= 2 && SUFFIX.includes(sub.slice(-1))) { hit = sub; break; }
      }
    }
    if (hit) { out.push(hit); i += hit.length; } else { i += 1; }
  }
  return out;
}

/** 字框 → 结构词列表（按行聚类 → 按间距分段 → 词典再切一层） */
function labelsFromWords(words) {
  if (!words || !words.length) return [];
  const ws = words
    .filter(w => w && w.t && String(w.t).trim())
    .map(w => ({ t: String(w.t).trim(), x: +w.x, y: +w.y, w: +w.w || 16, h: +w.h || 16 }));

  // 按 y 聚成行
  ws.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of ws) {
    const cy = w.y + w.h / 2;
    const line = lines.find(l => Math.abs(l.cy - cy) <= Math.max(8, w.h * 0.6));
    if (line) { line.ws.push(w); line.cy = (line.cy * (line.ws.length - 1) + cy) / line.ws.length; }
    else lines.push({ cy, ws: [w] });
  }

  const labels = [];
  for (const line of lines) {
    line.ws.sort((a, b) => a.x - b.x);
    const avgW = line.ws.reduce((s, w) => s + w.w, 0) / line.ws.length;
    const gapLimit = Math.max(9, avgW * 0.55);   // 超过这个间距视为两个标签
    let buf = '';
    let prevEnd = null;
    for (const w of line.ws) {
      if (prevEnd != null && w.x - prevEnd > gapLimit) {
        if (buf) labels.push(...labelsFromSegment(buf));
        buf = '';
      }
      buf += w.t;
      prevEnd = w.x + w.w;
    }
    if (buf) labels.push(...labelsFromSegment(buf));
  }

  // 过滤噪音：单字、纯数字/字母、过长
  const out = [];
  for (let l of labels) {
    l = clean(l);
    if (!l || l.length < 2 || l.length > 10) continue;
    if (/^[0-9A-Za-z.\-+±%]+$/.test(l)) continue;
    if (!/[\u4e00-\u9fa5]/.test(l)) continue;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

function labelsFromSegment(value) {
  const text = clean(value);
  if (!text) return [];
  const segmented = segmentByLexicon(text);
  if (segmented.length && segmented.reduce((sum, item) => sum + item.length, 0) >= text.length) return segmented;
  return /^[\u4e00-\u9fa5]{2,12}$/.test(text) ? [text] : [];
}

module.exports = { runOCR, labelsFromWords, segmentByLexicon, LEXICON };
