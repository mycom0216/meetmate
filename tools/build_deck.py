"""발표자료 생성: python tools/build_deck.py  →  docs/MeetMate_발표자료.pptx
python-pptx로 슬라이드를 코드로 만듭니다(수정은 이 파일을 고치고 다시 실행). 슬라이드 노트에 발표 멘트를 넣었습니다.
"""
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
FONT = "Malgun Gothic"
INK, MUTED = RGBColor(0x1B, 0x24, 0x30), RGBColor(0x66, 0x70, 0x85)
BRAND, SOFT, WHITE = RGBColor(0x0F, 0x76, 0x6E), RGBColor(0xE6, 0xF4, 0xF1), RGBColor(0xFF, 0xFF, 0xFF)
OK, WARN, BAD, LINE = RGBColor(0x0F, 0x9D, 0x6B), RGBColor(0xD9, 0x77, 0x06), RGBColor(0xD9, 0x2D, 0x20), RGBColor(0xE4, 0xE8, 0xF0)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]
N = 13


import math

WARNINGS = []


def estimate_height_pt(lines, width_in, size, safety=1.2):
    """글상자에 글이 몇 pt 높이로 들어갈지 어림합니다(한글 1자≈글자 크기, 영문·숫자≈0.55배, 폭 안전계수 1.2).
    PowerPoint와 다른 프로그램(Keynote, Google 슬라이드, WPS)은 글꼴이 달라 줄바꿈이 더 많아질 수 있어 여유를 둡니다."""
    avail = width_in * 72 - 14.4  # 기본 좌우 여백 0.1in씩
    total = 7.2  # 위아래 여백
    for ln in lines:
        w = sum(size * (1.0 if ord(c) > 0x2E80 else 0.55 if c != " " else 0.3) for c in ln) * safety
        total += max(1, math.ceil(w / avail)) * size * 1.3 + 4
    return total


def text(slide, x, y, w, h, s, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    for i, ln in enumerate(s if isinstance(s, list) else [s]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = ln
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = color
        p.space_after = Pt(4)
    need = estimate_height_pt(s if isinstance(s, list) else [s], w, size)
    if need > h * 72 + 1:
        WARNINGS.append(f"슬라이드 {len(prs.slides)}: 글상자 높이 부족 가능(필요 약 {need:.0f}pt > {h * 72:.0f}pt) : {(s if isinstance(s, str) else s[0])[:28]}")
    return tb


def box(slide, x, y, w, h, fill=SOFT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    else:
        s.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s


def card(slide, x, y, w, h, title, body, accent=BRAND, tsize=17, bsize=14):
    box(slide, x, y, w, h, WHITE, LINE)
    box(slide, x, y, 0.09, h, accent, None, MSO_SHAPE.RECTANGLE)
    text(slide, x + 0.25, y + 0.12, w - 0.4, 0.5, title, tsize, True)
    text(slide, x + 0.25, y + 0.68, w - 0.4, h - 0.8, body, bsize, False, MUTED)


def base(title, n, notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = RGBColor(0xF7, 0xF9, 0xFD)
    box(s, 0, 0, 13.333, 0.12, BRAND, None, MSO_SHAPE.RECTANGLE)
    text(s, 0.6, 0.35, 12, 0.8, title, 30, True)
    text(s, 12.0, 6.98, 1.0, 0.4, f"{n} / {N}", 11, False, MUTED, PP_ALIGN.RIGHT)
    text(s, 0.6, 6.98, 8, 0.4, "MeetMate · 로컬 음성 받아쓰기 기반 회의 정리 시스템", 11, False, MUTED)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def pic(slide, name, x, y, w=None, h=None):
    kw = {"width": Inches(w)} if w else {"height": Inches(h)}
    p = slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), **kw)
    p.line.color.rgb = LINE
    p.line.width = Pt(1)


# 평가 수치(tools/eval.mjs 결과, docs/MeetMate_테스트결과서.md와 동일해야 함)
EV = {
    "dev_f1": "100%", "h1_rule_r": "54.3%", "h2_rule_p": "100%", "h2_rule_r": "71.0%", "h2_rule_p_n": 100, "h2_rule_r_n": 71.0, "h2_hyb_p_n": 88.9, "h2_hyb_r_n": 77.4,
    "h2_hyb_p": "88.9%", "h2_hyb_r": "77.4%", "r1_hyb_p": "65.7%", "r1_hyb_r": "65.7%", "r1_rule_r": "54.3%",
    "cer": "1.7%", "wer": "11.1%", "speed": "0.25배",
}
LIGHT = RGBColor(0xDB, 0xF1, 0xEC)

# 1 표지
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 1.7, 11, 1.5, "MeetMate", 60, True, WHITE)
text(s, 0.9, 3.25, 11.8, 1.3, "로컬 음성 받아쓰기 기반 회의 정리 시스템", 28, False, WHITE)
text(s, 0.9, 4.8, 11.5, 0.6, "음성은 내 PC 밖으로 나가지 않고, AI가 지어낸 항목은 검증으로 걸러냅니다", 18, False, LIGHT)
text(s, 0.9, 6.3, 11.5, 0.5, "인공지능 응용 시스템 개발 종합 프로젝트 · 기획서 2026.12.04 · 발표 2026.12.30 · 반재영", 14, False, LIGHT)
s.notes_slide.notes_text_frame.text = "안녕하세요. 회의 녹음을 내 PC에서 받아쓰고 결정 사항과 할 일을 정리해 주는 MeetMate를 소개하겠습니다."

# 2 문제
s = base("왜 만들었나: 회의가 끝나면 합의가 사라진다", 2, "팀 프로젝트에서 의견 충돌과 일정 변경이 잦았는데 합의 내용이 남지 않았습니다. 클라우드 요약 서비스는 음성을 외부로 보내야 하고, 생성형 AI는 틀린 날짜와 담당자를 그럴듯하게 만듭니다.")
card(s, 0.6, 1.5, 3.9, 2.4, "① 누가 언제까지?", "회의 후 기억에 의존해 정리하다 보니 합의·담당·기한이 흐려집니다.", BRAND, 17, 15)
card(s, 4.7, 1.5, 3.9, 2.4, "② 음성을 밖으로?", "클라우드 받아쓰기·요약은 회의 음성을 외부 서버로 보내고 비용이 듭니다.", WARN, 17, 15)
card(s, 8.8, 1.5, 3.9, 2.4, "③ AI 요약을 믿어도 되나?", "없는 결정·틀린 날짜를 그럴듯하게 만들면 회의록이 오히려 해가 됩니다.", BAD, 17, 15)
box(s, 0.6, 4.3, 12.1, 2.1, BRAND)
text(s, 0.9, 4.5, 11.5, 0.55, "해결 방향", 20, True, WHITE)
text(s, 0.9, 5.15, 11.5, 1.1, ["로컬 받아쓰기 → 결정·할 일·미결 정리 → 모든 항목에 근거 발언 연결", "AI 제안은 검증을 통과한 것만 채택하고, 기한은 코드가 계산"], 17, False, WHITE)

# 3 기능
s = base("핵심 기능", 3, "음성 입력부터 근거 확인, 교정, 할 일 관리까지 하나의 흐름입니다.")
feats = [("로컬 받아쓰기", "ffmpeg + faster-whisper(small). 음성은 처리 후 즉시 삭제", BRAND),
         ("결정·할 일·미결 정리", "규칙 + AI 제안 + 검증. 담당자·기한 추출, 기한은 날짜로 계산", OK),
         ("근거 확인", "항목을 누르면 원문 구간·시각으로 이동. 근거 없는 항목은 저장 불가", WARN),
         ("교정·다시 정리", "틀린 받아쓰기를 고치면 요약·항목을 새로 생성, 완료 상태 유지", BRAND),
         ("할 일·검색", "전 회의 할 일 모아보기(기한 순), 원문 검색, 회의록(.md) 내려받기", WARN),
         ("기술 스택", "Node.js 24 · SQLite · faster-whisper · Ollama(선택) · 외부 npm 패키지 0개", MUTED)]
for i, (t, b, c) in enumerate(feats):
    card(s, 0.6 + (i % 2) * 6.15, 1.4 + (i // 2) * 1.85, 5.95, 1.7, t, b, c, 18, 14)

# 4 화면 입력·결과
s = base("화면 ①: 올리면 결정·할 일이 나온다", 4, "샘플 대본을 넣고 정리를 시작하면 결정 사항, 할 일, 미결 사항이 나옵니다. 할 일에는 담당자와 기한이 있고 기한은 회의 날짜 기준 실제 날짜입니다.")
pic(s, "crop-result.png", 0.6, 1.3, h=5.45)
card(s, 7.7, 1.5, 5.1, 1.55, "기한 = 날짜로 계산", "\"다음 주 월요일까지\" → 2026-12-07\n(AI가 아니라 코드가 계산)", BRAND, 16, 13)
card(s, 7.7, 3.25, 5.1, 1.55, "👍/👎 평가", "항목마다 도움이 됐는지 기록", OK, 16, 13)
card(s, 7.7, 5.0, 5.1, 1.75, "완료·수정", "체크하면 남은 할 일에서 빠지고, 담당자·기한은 직접 고칠 수 있음", WARN, 16, 13)

# 5 화면 음성
s = base("화면 ②: 실제 음성 결과와 정직한 안내", 5, "이것은 합성음을 실제 Whisper로 받아쓴 결과입니다. 배포가 폐포로, 유나가 윤아로 잘못 들렸고 화자를 구분하지 못해 제가로 시작하는 할 일은 담당자가 비어 있습니다. 화면이 이 한계를 안내하고 고칠 수 있게 합니다.")
pic(s, "crop-audio.png", 0.6, 1.3, w=6.0)
card(s, 6.9, 1.5, 5.9, 1.7, "오인식은 사용자가 고친다", "'폐포'를 '배포'로 고치고 \"다시 정리\"를 누르면 분류가 새로 됩니다", BAD, 16, 13)
card(s, 6.9, 3.4, 5.9, 1.7, "화자 구분 불가", "음성의 '제가 ~하겠습니다'는 담당자를 직접 지정", WARN, 16, 13)
card(s, 6.9, 5.3, 5.9, 1.5, "근거로 이동", "항목을 누르면 원문 구간으로 이동해 확인", BRAND, 16, 13)

# 6 구조
s = base("시스템 구조", 6, "http 층이 검증·제한·보안을 맡고 app 층이 작업 큐와 업무 흐름을 조립합니다. 받아쓰기는 자식 프로세스로 격리해 실패해도 서버가 살아 있습니다.")
for i, (t, b) in enumerate([("브라우저", "업로드·녹음·결과·교정"), ("http.mjs", "검증·제한·보안"), ("app.mjs", "작업 큐·흐름"), ("SQLite", "6개 테이블")]):
    x = 0.6 + i * 3.15
    box(s, x, 1.5, 2.7, 1.2, WHITE, BRAND)
    text(s, x, 1.6, 2.7, 0.5, t, 17, True, BRAND, PP_ALIGN.CENTER)
    text(s, x, 2.15, 2.7, 0.5, b, 13, False, MUTED, PP_ALIGN.CENTER)
mods = [("stt · whisper", "ffmpeg 변환 + Whisper, 자식 프로세스, 음성 삭제", OK), ("extract · dates", "규칙 추출, AI 제안 검증, 기한 날짜 계산", BRAND), ("transcript", "txt·SRT·VTT 파싱, 개인정보 마스킹", BRAND), ("llm · search", "Ollama/Claude/ChatGPT 어댑터, BM25 검색", WARN)]
for i, (t, b, c) in enumerate(mods):
    card(s, 0.6 + i * 3.1, 3.2, 2.95, 2.6, t, b, c, 15, 13)
text(s, 0.6, 6.1, 12, 0.6, "LLM·Whisper가 없어도 글 대본 정리는 규칙 기반으로 동작 (NFR-01)", 16, True, BRAND)

# 7 순서도
s = base("처리 순서도와 개발 절차 순서도", 7, "왼쪽은 개발 절차, 오른쪽은 프로그램 처리 순서도입니다. 입력 검사 실패, 음성/글 분기, AI 사용 가능 여부, 교정 반복을 모두 처리합니다.")
pic(s, "flow-dev.png", 0.6, 1.25, h=5.6)
pic(s, "flow-system.png", 5.0, 1.25, h=5.3)
card(s, 9.9, 1.5, 2.9, 2.4, "개발 절차", "기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 구현으로 반복", BRAND, 15, 12)
card(s, 9.9, 4.1, 2.9, 2.6, "처리 흐름", "입력 검사 → (음성) 받아쓰기 → 구간·마스킹 → 규칙 → AI 검증 → 요약 → 저장 → 교정 반복", OK, 15, 12)

# 8 환각 방지
s = base("핵심: AI를 믿지 않고 확인한다", 8, "규칙이 먼저 찾고 AI가 놓친 것을 제안하면 세 가지를 확인합니다. 근거 문장이 대본에 있는가, 숫자가 그대로인가, 문장 모양이 그 종류에 맞는가. 기한은 AI 값을 쓰지 않고 코드가 다시 계산합니다. 규칙은 원문 문장을 그대로 쓰므로 지어낼 수 없습니다.")
steps = [("1 규칙", "한국어 회의 말투 패턴, 원문 문장 그대로(지어낼 수 없음)"), ("2 AI 제안", "규칙이 놓친 구간을 로컬 LLM이 JSON으로 제안"), ("3 검증 관문", "근거 구간·문장 일치·새 숫자 금지·참석자 이름·말투 단서"), ("4 코드 재계산", "기한은 근거 문장에서 코드가 다시 계산, 담당자는 이름 대조")]
for i, (t, b) in enumerate(steps):
    card(s, 0.6 + i * 3.1, 1.5, 2.95, 2.7, t, b, [OK, WARN, BAD, BRAND][i], 17, 14)
box(s, 0.6, 4.5, 12.1, 2.1, SOFT)
text(s, 0.9, 4.65, 11.5, 1.9, ["측정으로 발견한 약점: '근거가 있다 ≠ 분류가 맞다'", "문장 일치만 검사했더니 3B 모델이 \"오늘 날씨 진짜 좋다\"를 할 일로 분류해도 통과 → 말투 단서 관문 추가(AI와 단서가 모두 동의해야 채택)", f"1라운드 AI 포함 정밀도 {EV['r1_hyb_p']} → 관문 추가 후 새 평가 세트 {EV['h2_hyb_p']}"], 15, False, INK)

# 9 ERD
s = base("데이터 설계 (ERD)", 9, "테이블 6개입니다. items의 회의 번호와 구간 번호가 segments를 가리키는 복합 외래키라서 근거 없는 항목은 저장 자체가 거부됩니다. 음성 파일은 저장하지 않습니다.")
pic(s, "erd.png", 0.6, 1.3, h=5.5)
card(s, 9.0, 1.5, 3.8, 1.5, "근거 보장", "복합 FK: 근거 구간 없는 항목 저장 불가", OK, 15, 12)
card(s, 9.0, 3.2, 3.8, 1.5, "개인정보", "마스킹 저장, 음성 미보관, 익명 ID", BAD, 15, 12)
card(s, 9.0, 4.9, 3.8, 1.5, "삭제", "CASCADE로 전체 삭제 한 번에", BRAND, 15, 12)

# 10 평가 차트
s = base("정리 정확도: 새 세트에서 확인한 것", 10, f"규칙을 만든 대본은 100%였지만 부풀려진 수치입니다. 보강에 쓰지 않은 새 세트에서 규칙은 정밀도 {EV['h2_rule_p']}, 재현율 {EV['h2_rule_r']}였고 AI를 더하면 재현율이 {EV['h2_hyb_r']}로 오르지만 정밀도는 {EV['h2_hyb_p']}로 내려갑니다. 모두 직접 만든 가상 대본입니다.")
cd = CategoryChartData()
cd.categories = ["규칙 정밀도", "규칙 재현율", "규칙+AI 정밀도", "규칙+AI 재현율"]
cd.add_series("새 평가 세트(%)", (EV["h2_rule_p_n"], EV["h2_rule_r_n"], EV["h2_hyb_p_n"], EV["h2_hyb_r_n"]))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.4), Inches(7.6), Inches(5.2), cd)
ch = gf.chart
ch.has_legend = False
ch.has_title = True
ch.chart_title.text_frame.text = "새 평가 세트(5건, 31개 정답) (%)"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
pl = ch.plots[0]
pl.has_data_labels = True
pl.data_labels.font.size = Pt(14)
pl.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
pl.series[0].format.fill.solid()
pl.series[0].format.fill.fore_color.rgb = BRAND
ch.value_axis.maximum_scale = 100
ch.value_axis.tick_labels.font.size = Pt(12)
ch.category_axis.tick_labels.font.size = Pt(12)
card(s, 8.5, 1.5, 4.3, 1.7, "개발용 대본 5건", f"F1 {EV['dev_f1']} — 규칙을 만든 대본이라 부풀려짐", WARN, 16, 13)
card(s, 8.5, 3.4, 4.3, 1.7, "받아쓰기(합성음)", f"글자 오류율 {EV['cer']}, 단어 {EV['wer']}, 속도 {EV['speed']}", BRAND, 16, 13)
card(s, 8.5, 5.3, 4.3, 1.5, "한계", "가상 대본·합성음. 실제 회의는 더 어려움", BAD, 16, 13)

# 11 테스트
s = base("테스트와 발견한 결함", 11, "자동 테스트가 통과하고, 핵심 로직을 일부러 망가뜨려 테스트가 잡는지도 확인했습니다. 평가에서 규칙 한계와 AI 분류 약점, 담당자 오류 한 건을 발견해 고쳤습니다.")
card(s, 0.6, 1.5, 5.9, 2.4, "자동 테스트 55개 통과", "형식 판별 · 음성 삭제 · IDOR · 413/415/429 · 복합 FK · 환각 차단 · 기한 계산 · 큐 직렬화", OK, 18, 14)
card(s, 6.8, 1.5, 5.9, 2.4, "변이 검사", "핵심 로직 10곳을 일부러 망가뜨려 보니 8곳을 테스트가 잡음. 못 잡은 2곳은 실제 동작에 차이가 없는 변경(설정 중복 등)이었음", BRAND, 17, 13)
box(s, 0.6, 4.2, 12.1, 2.5, WHITE, LINE)
text(s, 0.9, 4.3, 11.5, 0.5, "측정으로 발견해 고친 것", 17, True)
text(s, 0.9, 4.85, 11.5, 1.8, ["규칙은 정밀하지만 변형 표현을 많이 놓침(새 세트 재현율 71%) → 단서 보강 + AI 제안", "AI 포함 시 정밀도 하락(잡담을 할 일로 분류) → 말투 단서 관문·재분류 추가", "\"~해 주시면 좋겠어요\"를 말한 사람의 약속으로 오인 → 요청형으로 분류, 회귀 테스트", "한 발언의 두 문장이 할 일 2건으로 중복 → 기한 있는 쪽으로 합침"], 14, False, INK)

# 12 한계·일정
s = base("한계와 앞으로의 계획", 12, "정직하게 한계를 말씀드립니다. 평가 데이터가 직접 만든 가상 대본과 합성음이고, 화자 구분이 없고, 로그인이 없습니다. 12월에 실제 녹음과 사용자 평가를 할 계획입니다.")
card(s, 0.6, 1.5, 5.9, 3.4, "한계", "대본·음성 모두 가상(합성음은 실제 회의보다 쉬움)\n화자 구분 없음 → 음성의 담당자는 직접 지정\n규칙이 놓치는 표현이 있고 3B 모델은 분류가 불안정\n로그인 없음(127.0.0.1 전용)", BAD, 18, 15)
card(s, 6.8, 1.5, 5.9, 3.4, "일정", "12/04 기획서 제출\n12/08 핵심 기능 완성(완료)\n12/08~12/19 실제 녹음·사용자 평가\n12/24 결과보고서\n12/30 발표", BRAND, 18, 15)
text(s, 0.6, 5.3, 12, 1.0, "다음 개선: 실제 사람 목소리 평가 · 화자 구분 · 더 큰 모델(medium)/GPU · 로그인/HTTPS · Claude/ChatGPT 연동 실측", 16, False, INK)

# 13 마무리
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.0, 11.5, 1.4, "감사합니다", 54, True, WHITE)
text(s, 0.9, 3.6, 11.5, 1.2, ["음성은 내 PC 안에서, 정리는 근거와 함께", "질문 받겠습니다"], 24, False, LIGHT)
text(s, 0.9, 6.2, 11.5, 0.5, "소스·문서: projects/MeetMate · 실행: node server.mjs (Node.js 24+)", 14, False, LIGHT)

import sys

# 출력 경로를 인자로 바꿀 수 있습니다(파일이 PowerPoint에서 열려 있어 덮어쓸 수 없을 때 임시 파일로 먼저 확인하는 용도).
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "MeetMate_발표자료.pptx"
prs.save(out)
print("saved", out, "slides:", len(prs.slides))
for w in WARNINGS:
    print("WARN", w)
print("경고", len(WARNINGS), "건")
