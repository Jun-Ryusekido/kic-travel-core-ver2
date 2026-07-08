#!/usr/bin/env python3
"""
meal_voucher_sample.pdf (confirmed design sample) からミールバウチャーの
主要要素の座標(mm)・フォントスタイルを抽出し、voucher_layout_baseline.json
として保存する。

このベースラインは verify_voucher_layout.py が「現在のテンプレートが
確定サンプルからどれだけズレているか」を機械的に検証するために使う。

対象はブロック1（左上=KIC控えブロック、原点(0,0)はブロック左上）。
サンプルは4ブロックとも同一の相対レイアウトのため、ブロック1のみ解析すれば十分。

【意図的にサンプルから変更されている項目（ベースラインから除外）】
- お客様人数/大人/子供/FOC/Veg/Non-Veg/Jainの「数値」
  → 手書き記入方式に変更済み（別タスクで確定仕様）。空欄の枠のみ表示。
- 子供料金ポリシー注記の文言
  → 「50% of adult rate (3-6 yrs) / 80% of adult rate (7-11 yrs)」から
    「50% of adult rate (3-11 yrs)」に変更済み（別タスクで確定仕様）。
  これらはレイアウト回帰ではなく確定済みの仕様変更のため、本ベースラインの
  比較対象には含めない。
"""
import json
import sys

import pdfplumber

PT_TO_MM = 25.4 / 72.0
SAMPLE_PDF = "public/meal_voucher_sample.pdf"
OUTPUT_JSON = "voucher_layout_baseline.json"

# ブロック1の範囲 (pt)。サンプルはA4を単純に2x2分割しているため、
# ページ中心(x=297.6pt, y=421.0pt)がブロック境界。
BLOCK1_X_MAX = 297.6
BLOCK1_Y_MAX = 421.0


def is_bold_fontname(fontname):
    return "Bold" in fontname or "bold" in fontname


def char_style(chars):
    """複数文字にまたがる要素の代表フォントスタイルを返す（bold/regular）"""
    if not chars:
        return "unknown"
    bold_count = sum(1 for c in chars if is_bold_fontname(c["fontname"]))
    return "bold" if bold_count > len(chars) / 2 else "regular"


def word_style(page, word):
    """extract_words() の1単語に対応する文字群のスタイルを取得"""
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


def main():
    with pdfplumber.open(SAMPLE_PDF) as pdf:
        page = pdf.pages[0]
        words = [
            w for w in page.extract_words()
            if w["x0"] < BLOCK1_X_MAX and w["top"] < BLOCK1_Y_MAX
        ]
        rects = [
            r for r in page.rects
            if r["x0"] < BLOCK1_X_MAX and r["top"] < BLOCK1_Y_MAX
        ]
        # サンプルの罫線ボックス（署名欄・備考欄・お客様人数枠）は角丸のため
        # page.rects ではなく page.curves のバウンディングボックスとして検出される
        curves = [
            c for c in page.curves
            if c["x0"] < BLOCK1_X_MAX and c["top"] < BLOCK1_Y_MAX
        ]

        elements = []

        def add_text_element(name, text, occurrence=0, note="", skip_left=None):
            w = find_word(words, text, occurrence)
            if w is None:
                print(f"WARNING: word '{text}' (occurrence {occurrence}) not found for element '{name}'", file=sys.stderr)
                return
            el = {
                "name": name,
                "sample_text": text,
                "top_mm": round(w["top"] * PT_TO_MM, 2),
                "left_mm": round(w["x0"] * PT_TO_MM, 2),
                "font_weight": word_style(page, w),
                "note": note,
            }
            if skip_left:
                el["skip_left_check_reason"] = skip_left
            elements.append(el)

        # ヘッダー
        add_text_element("meal_voucher_title", "MEAL", note="「MEAL VOUCHER」の左上")
        add_text_element("tour_code_badge", "KIC1154_J1", note="ツアー番号ボックス")
        add_text_element("date_badge", "2026-12-14", note="日付ボックス")
        add_text_element("ctrl_badge", "KIC控え", note="KIC控え/レストラン控えバッジ")

        # ヘッダー下の区切り線（横長の塗りつぶし矩形として検出）
        rule_candidates = [
            r for r in rects
            if (r["x1"] - r["x0"]) > 150 and (r["bottom"] - r["top"]) < 2
        ]
        if rule_candidates:
            r = min(rule_candidates, key=lambda r: r["top"])
            elements.append({
                "name": "header_rule",
                "sample_text": None,
                "top_mm": round(r["top"] * PT_TO_MM, 2),
                "left_mm": round(r["x0"] * PT_TO_MM, 2),
                "width_mm": round((r["x1"] - r["x0"]) * PT_TO_MM, 2),
                "thickness_mm": round((r["bottom"] - r["top"]) * PT_TO_MM, 2),
                "font_weight": None,
                "note": "ヘッダー下の区切り線",
            })
        else:
            print("WARNING: header_rule rect not found", file=sys.stderr)

        # ラベル類（すべてサンプルでは通常ウェイト = 下線・太字なしのはず）
        add_text_element("label_restaurant", "レストラン", occurrence=0, note="「レストラン」ラベル")
        add_text_element("label_meal_type", "食事タイプ", note="「食事タイプ」ラベル")
        add_text_element("label_customer_count_heading", "お客様人数", note="「お客様人数」見出し（大人/子供行の上）")
        add_text_element("label_adult", "大人", note="「大人」ラベル")
        add_text_element(
            "label_child", "子供", note="「子供」ラベル",
            skip_left="大人/子供間の数値欄が手書き記入方式で幅広の空欄になったため、"
                      "「子供」ラベルの左位置はサンプルより右にずれるのが正しい（意図的な仕様変更）",
        )
        add_text_element("label_guide_name", "ガイド名", note="「ガイド名」ラベル")
        add_text_element("label_payment_method", "支払方法", note="「支払方法」ラベル")
        add_text_element("label_guide_signature", "ガイド署名", note="「ガイド署名」ラベル")
        add_text_element("label_restaurant_signature", "レストラン署名", note="「レストラン署名」ラベル")
        add_text_element("label_memo", "備考", note="「備考」ラベル")

        # 食事タイプのチェックボックス行 (B/L/D)
        add_text_element("meal_type_checkbox_b", "B", note="食事タイプチェックボックス「B」")

        def add_box_element(name, note, predicate, pick="first"):
            candidates = [c for c in curves if predicate(c)]
            if not candidates:
                print(f"WARNING: box '{name}' not found", file=sys.stderr)
                return
            candidates = sorted(candidates, key=lambda c: (c["top"], c["x0"]))
            c = candidates[0] if pick == "first" else candidates[-1]
            elements.append({
                "name": name,
                "sample_text": None,
                "top_mm": round(c["top"] * PT_TO_MM, 2),
                "left_mm": round(c["x0"] * PT_TO_MM, 2),
                "width_mm": round((c["x1"] - c["x0"]) * PT_TO_MM, 2),
                "height_mm": round((c["bottom"] - c["top"]) * PT_TO_MM, 2),
                "font_weight": None,
                "note": note,
            })

        # お客様人数ボックス（角丸、数値+ラベルを内包する枠）
        # しきい値は mm を pt に換算して比較する（curveの座標は pt 単位のため）
        add_box_element(
            "customer_count_box", "お客様人数ボックス（数値欄+ラベル）",
            lambda c: 10/PT_TO_MM < (c["x1"] - c["x0"]) < 20/PT_TO_MM
            and 12/PT_TO_MM < (c["bottom"] - c["top"]) < 20/PT_TO_MM
            and c["top"] < 200,
        )

        # 署名ボックス（ガイド署名側、角丸の矩形）
        add_box_element(
            "signature_box", "署名ボックス（ガイド署名側）",
            lambda c: 10/PT_TO_MM < (c["bottom"] - c["top"]) < 20/PT_TO_MM
            and 30/PT_TO_MM < (c["x1"] - c["x0"]) < 60/PT_TO_MM,
        )

        # 備考ボックス（角丸、横幅の広い矩形）
        add_box_element(
            "memo_box", "備考ボックス",
            lambda c: 10/PT_TO_MM < (c["bottom"] - c["top"]) < 30/PT_TO_MM and (c["x1"] - c["x0"]) > 70/PT_TO_MM,
        )

        baseline = {
            "source": SAMPLE_PDF,
            "position_tolerance_mm": 0.6,
            "block_origin": "ブロック1（左上=KIC控え）の左上を(0mm,0mm)とする",
            "excluded_intentional_deviations": [
                "お客様人数/大人/子供/FOC/Veg/Non-Veg/Jainの数値（手書き記入方式に変更済み、空欄表示が正）",
                "子供料金ポリシー注記の文言（3-11歳一律表記に変更済み）",
                "レストラン控え/KIC控えの左右配置（サンプル実データではKIC控えが左、レストラン控えが右）",
            ],
            "elements": elements,
        }

        with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
            json.dump(baseline, f, ensure_ascii=False, indent=2)

        print(f"Wrote {len(elements)} elements to {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
