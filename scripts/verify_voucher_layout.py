#!/usr/bin/env python3
"""
ミールバウチャーテンプレート(index.html の _buildVoucherHtml)が、
確定サンプル(meal_voucher_sample.pdf)から抽出したベースライン
(voucher_layout_baseline.json)とレイアウト面で一致しているかを検証する。

使い方:
    python scripts/verify_voucher_layout.py

やること:
  1. index.html から _buildVoucherHtml のソースを抜き出し、Node.js で
     サンプルと同じテストデータ(KIC1154_J1 等)を使って実際にHTMLを生成する
  2. headless Chrome で A4 PDFに印刷する
  3. pdfplumber で生成PDFのブロック1(KIC控え)を解析する
  4. baseline.json の各要素と座標(top/left, 許容誤差0.6mm)・
     font_weightを比較する
  5. 加えて、ラベル文字の直下に罫線が重なっていないか（=意図しない下線に
     見えてしまう不具合がないか）を全ラベルに対して機械的にチェックする
  6. 不一致があれば要素名・期待値・実際の値の一覧を表示し、
     終了コード1で終了する（CIやフックでの利用を想定）

このスクリプトは「確定サンプルと意図的に異なる」項目
(baseline.json の excluded_intentional_deviations を参照)は比較対象から
除外している。
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import os
from pathlib import Path

import pdfplumber

PT_TO_MM = 25.4 / 72.0
REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "index.html"
BASELINE_JSON = REPO_ROOT / "voucher_layout_baseline.json"
POSITION_TOLERANCE_MM = 0.6
BOX_SIZE_TOLERANCE_MM = 0.8  # 罫線ボックスの幅高さは太字より緩め（角丸の描画差を許容）

# サンプル(meal_voucher_sample.pdf)と同一のテストデータ
# ※この値を変えるとbaseline.jsonのsample_textと一致しなくなるので注意
TEST_RESTAURANTS = [
    {
        "restaurant_name": "○○レストラン 名古屋店", "meal_type": "夕食",
        "date": "2026-12-14", "payment_method": "請求書払い", "memo": "",
    },
    {
        "restaurant_name": "△△食堂 名古屋店", "meal_type": "朝食",
        "date": "2026-12-15", "payment_method": "請求書払い", "memo": "",
    },
]
TEST_TOUR_NAME = "KIC1154_J1"
TEST_GUIDE_NAME = "津崎 美穂"
TEST_GUIDE_PHONE = "090-1234-5678"

# 英語の長い店名・ガイド名・支払方法でもレイアウトが崩れない(はみ出さない)ことを
# 確認するための追加テストデータ(baseline.jsonの座標比較とは別枠のチェックに使う。
# 座標比較はTEST_RESTAURANTS(上記、確定サンプルと同一の短い日本語)を変更せず維持する)。
LONG_ENGLISH_TEST_RESTAURANTS = [
    {
        "restaurant_name": "INTERNATIONAL GRAND PALACE HOTEL RESTAURANT & BANQUET HALL COMPLEX",
        "restaurant_name_en": "INTERNATIONAL GRAND PALACE HOTEL RESTAURANT AND BANQUET HALL COMPLEX",
        "meal_type": "夕食", "date": "2026-12-14",
        "payment_method": "INTERNATIONAL TRAVEL AND TOURISM CONSOLIDATORS PVT LTD (INVOICE PAYMENT)",
        "memo": "",
    },
]
LONG_ENGLISH_TEST_TOUR_NAME = "KIC1154_J1"
LONG_ENGLISH_TEST_GUIDE_NAME = "Christopher Alexander Montgomery-Fitzgerald"
LONG_ENGLISH_TEST_GUIDE_PHONE = "090-1234-5678"

# 各動的フィールドが実際に印字時にはみ出していないかを、PDFから抽出した文字の
# 右端座標(mm)で機械的に判定するための期待右端(index.htmlのCSS/inline styleの
# left+width(またはmax-width)と一致させること)。
#
# 各フィールドの実テキストは、同じPDF内に実在する隣接ラベル文字列(レストラン/
# ガイド/支払方法。ALL_LABEL_TEXTS等で使っている確実に見つかる文字列)を
# find_wordで探し、そのラベルの実際の描画位置を基準に「同じ行の、ラベルより
# 右にある単語」とみなす。refboxはtour_name(短い固定長・省略されない想定)を
# そのまま検索する。
#
# 注意: 単語抽出時にBLOCK1_X_MAX(analyze_pdfのベースライン比較用、block1のみに
# 限定するためのpt境界)を流用しないこと。このチェックは「はみ出してblock1の
# 想定範囲を超えていないか」を見るためのものなので、あらかじめblock1相当の
# 狭い範囲で単語を切り捨ててしまうと、はみ出した文字自体が検出対象から漏れて
# 「はみ出しなし」と誤判定してしまう(実際にこの不具合を作り込んで検証中に発見した)。
OVERFLOW_CHECK_FIELDS = {
    # フィールド名: (アンカー方式, アンカー値, 期待される右端mm, 許容誤差mm)
    # 「レストラン：」はHTML上1つのdivにコロンまで含めて書かれているため、PDF抽出でも
    # 「レストラン」単独ではなく「レストラン：」の1語として抽出される(ガイド/支払方法は
    # ラベルとコロンが別divのため単独で抽出される、という違いに注意)。
    "restaurant_name":    ("label", "レストラン：", 122.321, 1.0),  # left:41.641mm + width:80.680mm
    "row_value_guide":    ("label", "ガイド", 126.225, 1.0),       # left:36.436mm + max-width:89.789mm
    "row_value_pay":      ("label", "支払方法", 126.225, 1.0),     # left:36.436mm + max-width:89.789mm
    "refbox":             ("exact", None, 65.414, 1.0),           # left:34.614mm + max-width:30.8mm(境界の緩衝込み)。値はtour_nameを実行時に渡す
}

# headless Chromeの日本語フォントのToUnicode CMapが不完全なため、
# PDFテキスト抽出時に一部の漢字が見た目の似たCJK部首（康熙部首）の
# コードポイントに化けることがある（表示上のグリフは正しく、抽出結果のみ
# 影響を受ける既知のPDF出力の癖）。比較の前に正規の漢字へ正規化する。
CJK_RADICAL_NORMALIZE = {
    "⾷": "食",  # ⾷→食
    "⼈": "人",  # ⼈→人
    "⼤": "大",  # ⼤→大
    "⼦": "子",  # ⼦→子
    "⽀": "支",  # ⽀→支
    "⽅": "方",  # ⽅→方
}


def normalize_cjk(text):
    for radical, kanji in CJK_RADICAL_NORMALIZE.items():
        text = text.replace(radical, kanji)
    return text


BLOCK1_X_MAX = 297.6
BLOCK1_Y_MAX = 421.0


def find_chrome():
    env_path = os.environ.get("CHROME_PATH")
    if env_path and Path(env_path).exists():
        return env_path
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    found = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("msedge")
    if found:
        return found
    raise RuntimeError(
        "Chrome/Edgeの実行ファイルが見つかりませんでした。"
        "環境変数 CHROME_PATH で明示的にパスを指定してください。"
    )


def extract_build_voucher_html_source():
    text = INDEX_HTML.read_text(encoding="utf-8")
    lines = text.split("\n")
    start = None
    for i, line in enumerate(lines):
        if "function _buildVoucherHtml" in line:
            start = i
            break
    if start is None:
        raise RuntimeError("index.html に _buildVoucherHtml が見つかりませんでした")

    depth = 0
    end = None
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0 and i > start:
            end = i
            break
    if end is None:
        raise RuntimeError("_buildVoucherHtml の終端を検出できませんでした")

    return "\n".join(lines[start:end + 1])


def generate_voucher_html(tmp_dir: Path, restaurants=None, tour_name=None, guide_name=None, guide_phone=None, out_name="voucher.html") -> Path:
    src = extract_build_voucher_html_source()
    restaurants = TEST_RESTAURANTS if restaurants is None else restaurants
    tour_name = TEST_TOUR_NAME if tour_name is None else tour_name
    guide_name = TEST_GUIDE_NAME if guide_name is None else guide_name
    guide_phone = TEST_GUIDE_PHONE if guide_phone is None else guide_phone
    node_script = f"""
const fs = require('fs');
global.window = {{ location: {{ origin: 'http://localhost:5500' }} }};
// _buildVoucherHtml が参照する、関数外で定義されたグローバル定数(index.html側)。
// このスクリプトは_buildVoucherHtml本体のみを抜き出すため、関数外の依存はここで
// 個別に補う必要がある(index.html:MEAL_VOUCHER_PAGE_SIZE定義箇所と値を一致させること)。
const MEAL_VOUCHER_PAGE_SIZE = 2;
{src}
const restaurants = {json.dumps(restaurants, ensure_ascii=False)};
let out = _buildVoucherHtml(restaurants, {json.dumps(tour_name)}, {json.dumps(guide_name)}, {json.dumps(guide_phone)});
out = out.replace(/\\/kic_travel_logo\\.jpg/g, {json.dumps(str((REPO_ROOT / 'public' / 'kic_travel_logo.jpg').resolve()).replace(chr(92), '/'))});
fs.writeFileSync({json.dumps(str((tmp_dir / out_name).resolve()).replace(chr(92), '/'))}, out);
"""
    node_script_path = tmp_dir / f"gen_{out_name}.js"
    node_script_path.write_text(node_script, encoding="utf-8")
    result = subprocess.run(["node", str(node_script_path)], cwd=REPO_ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"HTML生成に失敗しました:\n{result.stdout}\n{result.stderr}")
    return tmp_dir / out_name


def print_to_pdf(html_path: Path, pdf_path: Path):
    chrome = find_chrome()
    file_url = "file:///" + str(html_path.resolve()).replace("\\", "/")
    result = subprocess.run(
        [
            chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
            f"--print-to-pdf={pdf_path.resolve()}", "--print-to-pdf-no-header",
            file_url,
        ],
        capture_output=True, text=True, timeout=30,
    )
    if not pdf_path.exists():
        raise RuntimeError(f"PDF生成に失敗しました:\n{result.stdout}\n{result.stderr}")


def is_bold_fontname(fontname):
    return "Bold" in fontname or "bold" in fontname


def char_style(chars):
    if not chars:
        return "unknown"
    bold_count = sum(1 for c in chars if is_bold_fontname(c["fontname"]))
    return "bold" if bold_count > len(chars) / 2 else "regular"


def word_style(page, word):
    chars = [
        c for c in page.chars
        if word["x0"] - 0.5 <= c["x0"] <= word["x1"] + 0.5
        and word["top"] - 0.5 <= c["top"] <= word["bottom"] + 0.5
    ]
    return char_style(chars)


def find_word(words, text, occurrence=0):
    matches = [w for w in words if w["text"] == text]
    if len(matches) <= occurrence:
        return None
    return matches[occurrence]


def find_box(curves, width_mm_range, height_mm_range, top_lt_pt=None):
    lo_w, hi_w = [v / PT_TO_MM for v in width_mm_range]
    lo_h, hi_h = [v / PT_TO_MM for v in height_mm_range]
    candidates = [
        c for c in curves
        if lo_w < (c["x1"] - c["x0"]) < hi_w and lo_h < (c["bottom"] - c["top"]) < hi_h
        and (top_lt_pt is None or c["top"] < top_lt_pt)
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda c: (c["top"], c["x0"]))[0]


TEXT_ELEMENT_NAMES = {
    # 値: (検索テキスト, 何番目の一致を使うか)
    # 「お客様人数」はテンプレート内に2箇所（数値ボックス内の小ラベルと、
    # 大人/子供行の上の見出し）出現するため、occurrence=1で見出し側を指定する
    "meal_voucher_title": ("MEAL", 0),
    "tour_code_badge": (TEST_TOUR_NAME, 0),
    "date_badge": ("2026/12/14", 0),
    "ctrl_badge": ("KIC控え", 0),
    "label_restaurant": ("レストラン", 0),
    "label_meal_type": ("食事タイプ", 0),
    "label_customer_count_heading": ("お客様人数", 1),
    "label_adult": ("大人", 0),
    "label_child": ("子供", 0),
    "label_guide_name": ("ガイド名", 0),
    "label_payment_method": ("支払方法", 0),
    "label_guide_signature": ("ガイド署名", 0),
    "label_restaurant_signature": ("レストラン署名", 0),
    "label_memo": ("備考", 0),
    "meal_type_checkbox_b": ("B", 0),
}

BOX_ELEMENT_SIZE_RANGES = {
    "customer_count_box": ((10, 20), (12, 20)),
    "signature_box": ((30, 60), (10, 20)),
    "memo_box": ((70, 200), (10, 30)),
}

ALL_LABEL_TEXTS = [
    "レストラン", "食事タイプ", "お客様人数", "大人", "子供", "ガイド名",
    "支払方法", "ガイド署名", "レストラン署名", "備考",
]


def analyze_pdf(pdf_path: Path):
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        words = [w for w in page.extract_words() if w["x0"] < BLOCK1_X_MAX and w["top"] < BLOCK1_Y_MAX]
        for w in words:
            w["text"] = normalize_cjk(w["text"])
        rects = [r for r in page.rects if r["x0"] < BLOCK1_X_MAX and r["top"] < BLOCK1_Y_MAX]
        curves = [c for c in page.curves if c["x0"] < BLOCK1_X_MAX and c["top"] < BLOCK1_Y_MAX]

        actual = {}
        for name, (text, occurrence) in TEXT_ELEMENT_NAMES.items():
            w = find_word(words, text, occurrence)
            if w is None:
                actual[name] = None
                continue
            actual[name] = {
                "top_mm": w["top"] * PT_TO_MM,
                "left_mm": w["x0"] * PT_TO_MM,
                "font_weight": word_style(page, w),
                "bottom_mm": w["bottom"] * PT_TO_MM,
                "text_x0": w["x0"], "text_x1": w["x1"], "text_top": w["top"], "text_bottom": w["bottom"],
            }

        rule_candidates = [r for r in rects if (r["x1"] - r["x0"]) > 150 and (r["bottom"] - r["top"]) < 2]
        if rule_candidates:
            r = min(rule_candidates, key=lambda r: r["top"])
            actual["header_rule"] = {
                "top_mm": r["top"] * PT_TO_MM, "left_mm": r["x0"] * PT_TO_MM,
                "width_mm": (r["x1"] - r["x0"]) * PT_TO_MM,
                "thickness_mm": (r["bottom"] - r["top"]) * PT_TO_MM,
                "font_weight": None,
            }
        else:
            actual["header_rule"] = None

        # 角丸(curves)・直角(rects)どちらの罫線ボックスも検出対象にする
        # （サンプルは角丸、現テンプレートは直角の場合があるため）
        all_boxes = rects + curves
        for name, (w_range, h_range) in BOX_ELEMENT_SIZE_RANGES.items():
            top_lt = 200 / PT_TO_MM if name == "customer_count_box" else None
            box = find_box(all_boxes, w_range, h_range, top_lt_pt=top_lt)
            if box is None:
                actual[name] = None
                continue
            actual[name] = {
                "top_mm": box["top"] * PT_TO_MM, "left_mm": box["x0"] * PT_TO_MM,
                "width_mm": (box["x1"] - box["x0"]) * PT_TO_MM,
                "height_mm": (box["bottom"] - box["top"]) * PT_TO_MM,
                "font_weight": None,
            }

        # ラベル直下に罫線(枠線)が重なっていないかチェック（不要な下線に見える不具合の検出）
        overlap_issues = []
        for text in ALL_LABEL_TEXTS:
            w = find_word(words, text)
            if w is None:
                continue
            nearby_boxes = [c for c in all_boxes if c["top"] >= w["top"] - 2 and c["top"] < w["bottom"] + 3]
            for c in nearby_boxes:
                if c["x0"] < w["x1"] and c["x1"] > w["x0"] and c["top"] < w["bottom"]:
                    gap_mm = (c["top"] - w["bottom"]) * PT_TO_MM
                    if gap_mm < 0:
                        overlap_issues.append({"label": text, "overlap_mm": round(-gap_mm, 2)})

        return actual, overlap_issues


def check_long_english_no_overflow(pdf_path: Path, tour_name: str):
    """
    長い英語の店名・ガイド名・支払方法を使ったPDF(generate_voucher_html(...long_en...)で生成)
    から、各動的フィールドの実際の文字の右端座標(mm)を求め、OVERFLOW_CHECK_FIELDSで定義した
    期待右端(index.htmlのCSSのleft+width/max-widthから算出した値)を超えていないか判定する。
    fitFontSizeMixed等による自動縮小・ellipsisでの省略が正しく機能していれば、実際に
    印字される文字はこの右端に収まるはず(収まらない場合ははみ出し=不具合)。
    戻り値: 問題ありのフィールド一覧([{field, expected_right_mm, actual_right_mm, over_mm}, ...])
    """
    issues = []
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        # BLOCK1_X_MAXは使わない(analyze_pdfのベースライン比較専用の狭い境界で、
        # ここで流用するとはみ出した文字自体が抽出対象から漏れて検出できなくなる)。
        words = [w for w in page.extract_words() if w["top"] < BLOCK1_Y_MAX]
        for w in words:
            w["text"] = normalize_cjk(w["text"])

        for field, (anchor_type, anchor_value, expected_right_mm, tolerance_mm) in OVERFLOW_CHECK_FIELDS.items():
            if anchor_type == "exact":
                # refbox: tour_nameは短い固定長を想定しているため、値そのものを検索する
                anchor_word = find_word(words, tour_name)
                if anchor_word is None:
                    issues.append({"field": field, "note": f"値「{tour_name}」自体が見つかりません(要素が描画されていない可能性)"})
                    continue
                actual_right_mm = anchor_word["x1"] * PT_TO_MM
            else:
                # label: 隣接ラベル(block1側、occurrence=0=先頭に現れるもの)を検索し、
                # 同じ行(top±3pt)にあるラベルより右側の単語群の右端の最大値を、
                # 対象フィールドの実際の右端とみなす。x0側の上限は設けない
                # (はみ出した場合、隣のblockの領域まで文字が続くのを検出したいため)。
                label_word = find_word(words, anchor_value)
                if label_word is None:
                    issues.append({"field": field, "note": f"アンカーラベル「{anchor_value}」が見つかりません"})
                    continue
                row_words = [
                    w for w in words
                    if abs(w["top"] - label_word["top"]) < 3 and w["x0"] > label_word["x1"]
                ]
                if not row_words:
                    issues.append({"field": field, "note": f"ラベル「{anchor_value}」と同じ行に値のテキストが見つかりません"})
                    continue
                # 隣のblock(2つ目のKIC控え/レストラン控えペア)の同名ラベル自体が
                # 同じ行に来ることがあるため、次の「ラベルらしき」単語が現れたら
                # そこで打ち切り、対象フィールドの値だけを見るようにする。
                cutoff_mm = None
                for w in sorted(row_words, key=lambda w: w["x0"]):
                    if w["text"] in (anchor_value, "支払方法", "ガイド", "レストラン："):
                        cutoff_mm = w["x0"] * PT_TO_MM
                        break
                candidate_words = row_words
                if cutoff_mm is not None:
                    candidate_words = [w for w in row_words if w["x0"] * PT_TO_MM < cutoff_mm]
                if not candidate_words:
                    candidate_words = row_words
                actual_right_mm = max(w["x1"] for w in candidate_words) * PT_TO_MM

            if actual_right_mm > expected_right_mm + tolerance_mm:
                issues.append({
                    "field": field,
                    "expected_right_mm": round(expected_right_mm, 2),
                    "actual_right_mm": round(actual_right_mm, 2),
                    "over_mm": round(actual_right_mm - expected_right_mm, 2),
                })
    return issues


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    if not BASELINE_JSON.exists():
        print(f"ベースラインファイルが見つかりません: {BASELINE_JSON}", file=sys.stderr)
        print("先に `python scripts/extract_voucher_baseline.py` を実行してください。", file=sys.stderr)
        sys.exit(2)

    baseline = json.loads(BASELINE_JSON.read_text(encoding="utf-8"))
    tolerance = baseline.get("position_tolerance_mm", POSITION_TOLERANCE_MM)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        print("1. 現在のテンプレートからテストデータでHTMLを生成中...")
        html_path = generate_voucher_html(tmp_dir)

        print("2. headless ChromeでPDFに印刷中...")
        pdf_path = tmp_dir / "voucher.pdf"
        print_to_pdf(html_path, pdf_path)

        print("3. pdfplumberで生成PDFを解析中...")
        actual, overlap_issues = analyze_pdf(pdf_path)

        # 長い英語の店名・ガイド名・支払方法でもはみ出さないかの追加チェック。
        # baseline.jsonとの座標比較(短い日本語サンプル、上記の1〜3)とは完全に別枠で、
        # このチェックのみ失敗しても座標比較の結果には影響しない(別のテストデータのため)。
        print("3b. 長い英語データでのはみ出しチェック用PDFを生成・解析中...")
        long_en_html_path = generate_voucher_html(
            tmp_dir,
            restaurants=LONG_ENGLISH_TEST_RESTAURANTS,
            tour_name=LONG_ENGLISH_TEST_TOUR_NAME,
            guide_name=LONG_ENGLISH_TEST_GUIDE_NAME,
            guide_phone=LONG_ENGLISH_TEST_GUIDE_PHONE,
            out_name="voucher_long_en.html",
        )
        long_en_pdf_path = tmp_dir / "voucher_long_en.pdf"
        print_to_pdf(long_en_html_path, long_en_pdf_path)
        overflow_issues = check_long_english_no_overflow(long_en_pdf_path, LONG_ENGLISH_TEST_TOUR_NAME)

    print("4. ベースラインと比較中...\n")

    failures = []
    passes = 0

    for el in baseline["elements"]:
        name = el["name"]
        act = actual.get(name)
        if act is None:
            failures.append(f"[{name}] 現在のPDFに要素が見つかりません（{el.get('note','')}）")
            continue

        ok = True
        detail = []

        if "top_mm" in el and el["top_mm"] is not None:
            diff = abs(act["top_mm"] - el["top_mm"])
            if diff > tolerance:
                ok = False
                detail.append(f"top_mm: 期待={el['top_mm']} 実際={act['top_mm']:.2f} 差={diff:.2f}mm (許容{tolerance}mm)")

        if el.get("skip_left_check_reason"):
            detail.append(f"(left_mmチェックを除外: {el['skip_left_check_reason']})")
        elif "left_mm" in el and el["left_mm"] is not None:
            diff = abs(act["left_mm"] - el["left_mm"])
            if diff > tolerance:
                ok = False
                detail.append(f"left_mm: 期待={el['left_mm']} 実際={act['left_mm']:.2f} 差={diff:.2f}mm (許容{tolerance}mm)")

        if el.get("width_mm") is not None and act.get("width_mm") is not None:
            diff = abs(act["width_mm"] - el["width_mm"])
            if diff > BOX_SIZE_TOLERANCE_MM:
                ok = False
                detail.append(f"width_mm: 期待={el['width_mm']} 実際={act['width_mm']:.2f} 差={diff:.2f}mm (許容{BOX_SIZE_TOLERANCE_MM}mm)")

        if el.get("height_mm") is not None and act.get("height_mm") is not None:
            diff = abs(act["height_mm"] - el["height_mm"])
            if diff > BOX_SIZE_TOLERANCE_MM:
                ok = False
                detail.append(f"height_mm: 期待={el['height_mm']} 実際={act['height_mm']:.2f} 差={diff:.2f}mm (許容{BOX_SIZE_TOLERANCE_MM}mm)")

        if el.get("font_weight") is not None and act.get("font_weight") is not None:
            if act["font_weight"] != el["font_weight"]:
                ok = False
                detail.append(f"font_weight: 期待={el['font_weight']} 実際={act['font_weight']}")

        if ok:
            passes += 1
        else:
            failures.append(f"[{name}] {el.get('note','')}\n    " + "\n    ".join(detail))

    print("--- ラベルの意図しない下線（罫線との重なり）チェック ---")
    if overlap_issues:
        for issue in overlap_issues:
            failures.append(f"[underline_check] ラベル「{issue['label']}」の直下{issue['overlap_mm']}mmに罫線が重なっています（下線に見える不具合の可能性）")
        print(f"  NG: {len(overlap_issues)}件の重なりを検出")
    else:
        print("  OK: 全ラベルで罫線の重なりなし")

    print("--- 長い英語データでのはみ出しチェック ---")
    if overflow_issues:
        for issue in overflow_issues:
            if "note" in issue:
                failures.append(f"[long_english_overflow] {issue['field']}: {issue['note']}")
            else:
                failures.append(
                    f"[long_english_overflow] {issue['field']}: 期待右端={issue['expected_right_mm']}mm "
                    f"実際={issue['actual_right_mm']}mm ({issue['over_mm']}mmはみ出し)"
                )
        print(f"  NG: {len(overflow_issues)}件のはみ出しを検出")
    else:
        print("  OK: 長い英語データでもはみ出しなし")

    print(f"\n=== 結果: {passes}/{len(baseline['elements'])} 要素が一致 ===\n")

    if failures:
        print(f"不一致 {len(failures)}件:\n")
        for f in failures:
            print(f"  ✗ {f}\n")
        sys.exit(1)
    else:
        print("すべての項目がベースラインと一致しました。")
        sys.exit(0)


if __name__ == "__main__":
    main()
