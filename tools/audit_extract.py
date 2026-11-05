#!/usr/bin/env python3
"""Build a read-only inventory and evidence map for an APQP project folder."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

from openpyxl import load_workbook
from pypdf import PdfReader


WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--conversion-manifest", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def parse_docx(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))

    texts = []
    for paragraph in root.iter(f"{WORD_NS}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{WORD_NS}t")).strip()
        if text:
            texts.append(text)

    tables = []
    for table in list(root.iter(f"{WORD_NS}tbl"))[:4]:
        rows = []
        for row in list(table.iter(f"{WORD_NS}tr"))[:8]:
            cells = []
            for cell in row.iter(f"{WORD_NS}tc"):
                cells.append("".join(node.text or "" for node in cell.iter(f"{WORD_NS}t")).strip())
            if any(cells):
                rows.append(cells)
        if rows:
            tables.append(rows)

    return {
        "title": texts[0] if texts else "",
        "text": " | ".join(texts[:18]),
        "tables": len(list(root.iter(f"{WORD_NS}tbl"))),
        "table_preview": tables,
    }


def parse_xlsx(path: Path) -> dict:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheets = []
        for worksheet in workbook.worksheets:
            preview = []
            for row in worksheet.iter_rows(
                min_row=1,
                max_row=min(worksheet.max_row, 20),
                values_only=True,
            ):
                values = [str(value).strip() for value in row if value not in (None, "")]
                if values:
                    preview.append(values[:12])
                if len(preview) >= 8:
                    break
            sheets.append(
                {
                    "name": worksheet.title,
                    "rows": worksheet.max_row,
                    "columns": worksheet.max_column,
                    "preview": preview,
                }
            )
        first = sheets[0] if sheets else {"name": "", "rows": 0, "columns": 0, "preview": []}
        first_value = next((value for row in first["preview"] for value in row), "")
        return {
            "title": first_value,
            "text": f"{len(sheets)} 个工作表：" + "、".join(item["name"] for item in sheets[:10]),
            "sheets": sheets,
        }
    finally:
        workbook.close()


def parse_pdf(path: Path) -> dict:
    reader = PdfReader(str(path))
    first_text = ""
    for page in reader.pages[:2]:
        extracted = (page.extract_text() or "").strip()
        if extracted:
            first_text = extracted.replace("\n", " | ")
            break
    return {"title": first_text[:100], "text": first_text[:1000], "pages": len(reader.pages)}


def phase_of(relative: Path) -> str:
    first = relative.parts[0] if relative.parts else ""
    match = re.match(r"0([1-4])、", first)
    if match:
        return f"阶段{match.group(1)}"
    if "归档版" in first:
        return "归档版"
    if "装配图" in first:
        return "装配图"
    if "包装图" in first:
        return "包装图"
    return "根目录"


def category_of(path: Path, size: int, duplicate_group: str) -> str:
    name = path.name
    if name.startswith("~$"):
        return "Office锁文件"
    if size == 0:
        return "空白模板"
    if duplicate_group:
        return "重复/归档副本"
    if "PPAP文件包" in str(path):
        return "PPAP证据"
    if "作业指导书" in str(path) or "工艺文件" in str(path):
        return "工艺文件"
    if "检查表" in name:
        return "检查表"
    if path.suffix.lower() in {".dwg", ".bak", ".log", ".png"}:
        return "图纸/辅助文件"
    if path.suffix.lower() in {".docx", ".doc", ".xlsx", ".xls", ".pdf"}:
        return "正式业务文件"
    return "其他文件"


RULES = [
    (r"跨部门职能项目小组成员", ["P0-01"], "已映射"),
    (r"APQP计划|设计开发任务表", ["P0-10"], "已映射"),
    (r"项目立项论证报告|立项评审报告", ["P0-02"], "部分映射"),
    (r"原材料清单", ["P1-09"], "部分映射"),
    (r"产品质量保证计划", ["P1-12", "P1-17"], "部分映射"),
    (r"产品和过程特殊特性清单", ["SPECIAL"], "部分映射"),
    (r"产品初始过程流程图|产品过程流程图", ["PFD"], "已映射"),
    (r"详细规范", ["P2-07"], "已映射"),
    (r"产品图纸|装配图", ["P2-06"], "部分映射"),
    (r"包装图纸|包装图", ["P3-02"], "部分映射"),
    (r"材料规范", ["P2-08"], "部分映射"),
    (r"DFMEA检查表", ["A-02"], "已映射"),
    (r"DFMEA", ["P2-01"], "已映射"),
    (r"设计信息检查表", ["A-03"], "已映射"),
    (r"设备、工装和试验设备检查表", ["A-04"], "已映射"),
    (r"设备、工装和试验设备清单", ["P2-10"], "已映射"),
    (r"样件控制计划检查表", ["A-11"], "部分映射"),
    (r"样件控制计划", ["P2-05"], "已映射"),
    (r"样件生产制造计划", ["P2-05"], "支撑资料"),
    (r"设计开发验证计划|设计验证计划|验证试验计划", ["P2-03"], "部分映射"),
    (r"设计开发验证报告|设计验证报告", ["P2-03"], "已映射"),
    (r"新品样品交付表|新品样品阶段结论", ["P2-04"], "支撑资料"),
    (r"小组可行性承诺", ["P2-13"], "已映射"),
    (r"过程设计开发输入信息表|过程设计开发输入评审报告", ["P3-03"], "支撑资料"),
    (r"过程流程图检查表", ["A-07"], "已映射"),
    (r"PFMEA检查表", ["A-08"], "已映射"),
    (r"PFAMA|PFMEA", ["P3-06"], "已映射"),
    (r"车间平面|布局图|定置图", ["P3-05"], "已映射"),
    (r"初始过程能力分析计划", ["P3-09"], "已映射"),
    (r"作业指导书|专用工艺说明|工艺文件|工装部分|材料消耗定额", ["P3-07"], "支撑资料"),
    (r"测量系统分析计划", ["P3-08"], "部分映射"),
    (r"试生产控制计划", ["P3-06b"], "已映射"),
    (r"临时变更清单", ["P2-09", "A-09"], "部分映射"),
    (r"产品质量体系检查表", ["P3-03", "A-05"], "已映射"),
    (r"试生产生产制造计划", ["P4-01"], "支撑资料"),
    (r"测量系统评价报告", ["P4-02"], "已映射"),
    (r"初始过程能力评价|初始过程能力研究结果", ["P4-03"], "已映射"),
    (r"生产线平衡|产能分析", ["P1-13", "P4-09"], "部分映射"),
    (r"包装评价报告", ["P4-06"], "已映射"),
    (r"生产过程确认记录", ["P4-01"], "已映射"),
    (r"鉴定检验|试验报告|试验计划", ["P4-05"], "部分映射"),
    (r"量产控制计划", ["P4-07"], "已映射"),
    (r"PPAP文件清单|PPAP清单附件|PPAP表格", ["P4-04"], "已映射"),
    (r"产品质量策划总结|质量策划总结和认定", ["P4-08"], "已映射"),
    (r"文件归档清单|量产交接清单", ["P4-08", "P4-09"], "部分映射"),
    (r"设计开发阶段评审报告|阶段研制总结报告|设计开发输出信息表", ["REVIEW"], "部分映射"),
]


def mapped_codes(relative: Path) -> tuple[list[str], str]:
    path = str(relative).replace("\\", "/")
    phase = phase_of(relative)
    for pattern, codes, status in RULES:
        if not re.search(pattern, path, re.IGNORECASE):
            continue
        resolved = []
        for code in codes:
            if code == "SPECIAL":
                resolved.append("P2-11" if phase == "阶段3" else "P1-11")
            elif code == "PFD":
                resolved.append("P3-04" if phase == "阶段3" else "P1-10")
            elif code == "REVIEW":
                resolved.append(
                    {"阶段1": "P2-04", "阶段2": "P2-04", "阶段3": "P3-03", "阶段4": "P4-08"}
                    .get(phase, "P2-04")
                )
            else:
                resolved.append(code)
        return sorted(set(resolved)), status
    return [], "待确认"


STATUS_OVERRIDES = {
    "P0-01": ("部分具备", "原表含联系方式、技能要求和具备情况，系统 P0-01 仅 6 列"),
    "P0-02": ("部分具备", "立项报告覆盖顾客/范围/可行性，但未按系统范围矩阵逐项拆分"),
    "P0-05": ("缺失", "没有独立供应商来源与高风险评估记录"),
    "P0-10": ("已具备", "APQP计划和设计开发任务表提供阶段、任务、日期、交付物、责任部门"),
    "P1-I-01": ("部分具备", "立项报告含市场/用户需求，但未形成系统 VOC 表"),
    "P1-I-06": ("部分具备", "详细规范和立项资料包含顾客要求，需逐条形成受控要求清单"),
    "P1-07": ("部分具备", "设计目标散落在详细规范和立项报告，需按系统目标表转写"),
    "P1-08": ("部分具备", "可靠性/质量目标需从详细规范试验要求提取"),
    "P1-09": ("部分具备", "原材料清单字段比系统 BOM 多检验规范和质量要求"),
    "P1-10": ("已具备", "现有产品初始过程流程图可直接映射工序路线"),
    "P1-11": ("部分具备", "特殊特性有工序/产品/过程/规范/符号，但缺系统特性编号和明确识别主体"),
    "P1-12": ("已具备", "产品质量保证计划包含风险、主要失效模式和措施"),
    "P1-13": ("部分具备", "产能分析在阶段4提供实际数据，阶段1目标计划需补充"),
    "P1-14": ("部分具备", "阶段评审记录体现管理者支持，但没有单独领导支持表"),
    "P1-15": ("部分具备", "临时变更清单可作证据，但缺系统分级审批规则"),
    "P1-16": ("部分具备", "APQP计划提供项目节点，缺系统质量/成本/交付指标基线"),
    "P1-17": ("部分具备", "质量保证计划有风险与主要失效模式，缺完整 REMS 责任人/期限"),
    "P2-01": ("已具备", "新版 DFMEA Excel 含结构、功能、失效、PC/DC、S/O/D/AP 和措施"),
    "P2-02": ("部分具备", "项目立项和过程输入评审涉及可制造性，但没有系统 DFM/DFA 检查项"),
    "P2-03": ("已具备", "样件验证计划、报告和试验数据记录可合并为 DVP&R"),
    "P2-04": ("已具备", "各阶段设计评审报告与输出评审报告可追溯"),
    "P2-05": ("已具备", "样件控制计划存在，需转成 CP PROTO 行"),
    "P2-06": ("部分具备", "产品图纸/装配图存在，产品图纸 docx 是零字节占位"),
    "P2-07": ("已具备", "Q/RV570-2023 详细规范为产品规范主依据"),
    "P2-08": ("部分具备", "材料规范占位文件为空，详细规范和原材料清单含部分材料要求"),
    "P2-09": ("部分具备", "临时变更清单存在，但正式图纸/规范变更记录不全"),
    "P2-10": ("已具备", "设备、工装和试验设备清单/检查表已提供"),
    "P2-11": ("已具备", "阶段3特殊特性清单已正式维护"),
    "P2-12": ("部分具备", "测量设备信息散落在设备清单、MSA计划和检查报告"),
    "P2-13": ("已具备", "小组可行性承诺已签署栏目存在"),
    "P3-02": ("部分具备", "包装图纸和包装评价存在，包装标准和规范需整合"),
    "P3-03": ("已具备", "产品质量体系检查表和过程阶段评审报告已提供"),
    "P3-04": ("已具备", "阶段3产品过程流程图可作为 PFD 主数据"),
    "P3-05": ("已具备", "车间平面定置图、布局图和检查表已提供"),
    "P3-06": ("已具备", "旧版 PFMEA/PFAMA Excel 已成功转换，可按七步法字段导入"),
    "P3-06b": ("已具备", "试生产控制计划存在，需与 PFD/PFMEA 特性关联"),
    "P3-07": ("已具备", "关键/特殊工序作业指导书和工艺文件成套"),
    "P3-08": ("部分具备", "MSA计划表存在但项目名称/型号/量具项目大量空白，另有评价报告"),
    "P3-09": ("已具备", "初始过程能力研究计划已提供"),
    "P3-10": ("部分具备", "阶段评审记录体现资源支持，无独立领导支持记录"),
    "P4-01": ("部分具备", "生产过程确认记录完整，工作令与检验记录为空模板"),
    "P4-02": ("已具备", "测量系统评价报告已提供，原始数据完整度需复核"),
    "P4-03": ("已具备", "镍层、锡铅层、锡层初始能力数据含规格和Pp/Ppk"),
    "P4-04": ("部分具备", "PPAP清单、PSW、18项表格和证据包存在，提交等级/顾客批准需确认"),
    "P4-05": ("部分具备", "鉴定/验证试验计划存在，试验报告仍为零字节缺项模板"),
    "P4-06": ("已具备", "包装评价报告已提供"),
    "P4-07": ("已具备", "量产控制计划已提供，需与试生产CP阶段继承核对"),
    "P4-08": ("已具备", "产品质量策划总结和认定表已提供"),
    "P4-09": ("已具备", "量产交接清单已提供，生产线平衡/产能分析可作支撑"),
    "A-01": ("缺失", "没有独立 APQP 风险因素检查表"),
    "A-02": ("已具备", "DFMEA检查表已提供"),
    "A-03": ("已具备", "产品设计信息检查表已提供"),
    "A-04": ("已具备", "设备、工装和试验设备检查表已提供"),
    "A-05": ("已具备", "产品质量体系检查表已提供"),
    "A-06": ("已具备", "车间平面定置图检查表已提供"),
    "A-07": ("已具备", "过程流程图检查表已提供"),
    "A-08": ("已具备", "PFMEA检查表已提供"),
    "A-09": ("部分具备", "临时变更清单可作证据，缺系统变更管理检查表"),
    "A-10": ("缺失", "没有独立采购检查表，原材料清单不能替代"),
    "A-11": ("部分具备", "样件控制计划检查表存在，量产CP检查需补"),
    "P5-01": ("缺失", "项目资料未包含量产持续降低变差记录"),
    "P5-02": ("缺失", "项目资料未包含顾客满意度记录"),
    "P5-03": ("缺失", "项目资料未包含交付和服务绩效记录"),
    "P5-04": ("缺失", "项目资料未包含经验教训与最佳实践总结"),
}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    root = Path(args.project_root).resolve()
    manifest_path = Path(args.conversion_manifest).resolve()
    output = Path(args.output).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    conversions = {str(Path(item["source"]).resolve()): item for item in manifest}

    files = sorted(path for path in root.rglob("*") if path.is_file())
    hashes = defaultdict(list)
    for path in files:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        hashes[(path.suffix.lower(), path.stat().st_size, digest)].append(path)

    duplicate_ids = {}
    duplicate_counter = 0
    for key, paths in hashes.items():
        if len(paths) <= 1 or key[1] == 0:
            continue
        duplicate_counter += 1
        group = f"DUP-{duplicate_counter:03d}"
        for path in paths:
            duplicate_ids[str(path.resolve())] = group

    rows = []
    for index, path in enumerate(files, start=1):
        relative = path.relative_to(root)
        size = path.stat().st_size
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        dup = duplicate_ids.get(str(path.resolve()), "")
        is_lock = path.name.startswith("~$")
        parse_source = path
        conversion = conversions.get(str(path.resolve()))
        conversion_status = ""
        if conversion:
            conversion_status = conversion["status"]
            if conversion["status"] == "converted":
                parse_source = Path(conversion["converted"])

        parsed = {}
        parse_status = ""
        if is_lock:
            parse_status = "跳过：Office锁文件"
        elif size == 0:
            parse_status = "跳过：零字节空白模板"
        elif path.suffix.lower() in {".doc", ".xls"}:
            if conversion_status == "converted":
                try:
                    parsed = parse_docx(parse_source) if parse_source.suffix.lower() == ".docx" else parse_xlsx(parse_source)
                    parse_status = "已临时转换并解析"
                except Exception as exc:  # noqa: BLE001
                    parse_status = f"转换后解析失败：{type(exc).__name__}"
            else:
                parse_status = "旧版文件转换失败"
        elif path.suffix.lower() == ".docx":
            try:
                parsed = parse_docx(path)
                parse_status = "已解析"
            except Exception as exc:  # noqa: BLE001
                parse_status = f"解析失败：{type(exc).__name__}"
        elif path.suffix.lower() == ".xlsx":
            try:
                parsed = parse_xlsx(path)
                parse_status = "已解析"
            except Exception as exc:  # noqa: BLE001
                parse_status = f"解析失败：{type(exc).__name__}"
        elif path.suffix.lower() == ".pdf":
            try:
                parsed = parse_pdf(path)
                parse_status = "已解析"
            except Exception as exc:  # noqa: BLE001
                parse_status = f"解析失败：{type(exc).__name__}"
        else:
            parse_status = "未解析：非 Word/Excel/PDF"

        codes, map_status = mapped_codes(relative)
        category = category_of(relative, size, dup)
        if is_lock:
            map_status = "跳过"
        elif size == 0:
            map_status = "空白模板"
        elif dup:
            map_status = "重复归档"

        rows.append(
            {
                "序号": index,
                "阶段目录": phase_of(relative),
                "相对路径": str(relative),
                "文件名": path.name,
                "扩展名": path.suffix.lower() or "[无扩展名]",
                "大小KB": round(size / 1024, 2),
                "SHA256": digest,
                "重复组": dup,
                "文件类别": category,
                "识别编号": ";".join(codes),
                "映射状态": map_status,
                "解析状态": parse_status,
                "标题/首个内容": parsed.get("title", "")[:250],
                "内容摘要": parsed.get("text", "")[:1200],
                "表格/工作表摘要": json.dumps(
                    parsed.get("table_preview") or parsed.get("sheets") or [],
                    ensure_ascii=False,
                )[:2500],
                "转换状态": conversion_status,
                "备注": (
                    "Office 锁文件"
                    if is_lock
                    else "零字节占位文件"
                    if size == 0
                    else f"与 {dup} 同哈希"
                    if dup
                    else ""
                ),
            }
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "total": len(rows),
                "extensions": dict(Counter(row["扩展名"] for row in rows)),
                "phases": dict(Counter(row["阶段目录"] for row in rows)),
                "duplicate_groups": duplicate_counter,
                "locks": sum(1 for row in rows if row["文件类别"] == "Office锁文件"),
                "blank": sum(1 for row in rows if row["文件类别"] == "空白模板"),
                "output": str(output),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
