"""순서도 이미지 생성: python tools/make_flow.py → docs/images/flow-dev.png, flow-system.png
 - flow-dev.png    : 개발 절차 순서도(기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 구현으로 되돌아가는 반복 포함)
 - flow-system.png : 프로그램 처리 순서도(입력 → 검사 → (음성이면) 받아쓰기 → 구간·마스킹 → 규칙 추출 → AI 검증 → 요약 → 저장 → 교정 반복)
표준 순서도 기호: 둥근 사각형=시작/끝, 사각형=처리, 마름모=판단, 평행사변형=입출력. 처리 순서도는 한 쪽에 담기도록 2열로 배치했습니다.
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon

plt.rcParams["font.family"] = "Malgun Gothic"
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
BRAND, GREEN, RED, ORANGE, INK = "#0f766e", "#0f9d6b", "#d92d20", "#d97706", "#1b2430"


class Flow:
    def __init__(self, w, h, y0=-1.2):
        self.fig, self.ax = plt.subplots(figsize=(w, h - y0 if y0 < 0 else h - y0))
        self.ax.set_xlim(-1.2, w + 0.8)
        self.ax.set_ylim(y0, h)
        self.ax.axis("off")
        self.nodes = {}

    def node(self, key, x, y, text, kind="proc", w=3.4, h=0.8):
        a = self.ax
        if kind == "term":
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.3", fc=BRAND, ec=BRAND, zorder=3))
            col = "white"
        elif kind == "dec":
            hw, hh = w / 2 + 0.2, h / 2 + 0.25
            a.add_patch(Polygon([(x, y + hh), (x + hw, y), (x, y - hh), (x - hw, y)], fc="#fff7e6", ec=ORANGE, lw=1.8, zorder=3))
            col = INK
        elif kind == "io":
            s = 0.3
            a.add_patch(Polygon([(x - w / 2 + s, y + h / 2), (x + w / 2 + s, y + h / 2), (x + w / 2 - s, y - h / 2), (x - w / 2 - s, y - h / 2)], fc="#e6f4f1", ec=BRAND, lw=1.8, zorder=3))
            col = INK
        else:
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.08", fc="white", ec=BRAND, lw=1.8, zorder=3))
            col = INK
        a.text(x, y, text, ha="center", va="center", fontsize=11, color=col, zorder=5, fontweight="bold" if kind == "term" else "normal")
        hh = (h / 2 + 0.25) if kind == "dec" else h / 2
        hw = (w / 2 + 0.2) if kind == "dec" else w / 2
        self.nodes[key] = (x, y, hw, hh)

    def pt(self, key, side):
        x, y, hw, hh = self.nodes[key]
        return {"t": (x, y + hh), "b": (x, y - hh), "l": (x - hw, y), "r": (x + hw, y)}[side]

    def arrow(self, a, sa, b, sb, label="", via=None, color="#475467"):
        p1, p2 = self.pt(a, sa), self.pt(b, sb)
        pts = [p1] + (via or []) + [p2]
        for i in range(len(pts) - 1):
            last = i == len(pts) - 2
            self.ax.annotate("", xy=pts[i + 1], xytext=pts[i], zorder=2,
                             arrowprops=dict(arrowstyle="-|>" if last else "-", color=color, lw=1.5, shrinkA=0, shrinkB=0))
        if label:
            mx, my = pts[0][0] + (pts[1][0] - pts[0][0]) * 0.35, pts[0][1] + (pts[1][1] - pts[0][1]) * 0.35
            self.ax.text(mx + 0.12, my + 0.08, label, fontsize=10, color=RED if label.startswith("아니") else GREEN, fontweight="bold", zorder=6,
                         bbox=dict(fc="white", ec="none", pad=1))

    def save(self, name, title):
        self.ax.text(-1.0, self.ax.get_ylim()[1] - 0.35, title, fontsize=16, fontweight="bold", color=INK)
        self.fig.savefig(OUT / name, dpi=110, bbox_inches="tight", facecolor="white")
        print("saved", OUT / name)


# ── 1) 개발 절차 순서도 ──────────────────────────────────────────────
f = Flow(9, 12.4)
f.node("s", 4.5, 11.3, "시작 (2026-11-26)", "term", 3.0, 0.7)
f.node("p1", 4.5, 10.1, "1 기획\n주제·범위 확정, 기획서 작성 (~12/04 제출)", "proc", 5.4)
f.node("p2", 4.5, 8.8, "2 설계\n요구사항 분석서·명세서, 아키텍처, ERD", "proc", 5.4)
f.node("p3", 4.5, 7.5, "3 분석·구현\n받아쓰기(Whisper), 정리 로직, DB·API, 화면", "proc", 5.4)
f.node("p4", 4.5, 6.2, "4 테스트\n자동 테스트, 정확도 평가, 사용자 평가", "proc", 5.4)
f.node("d1", 4.5, 4.7, "결함·개선 사항이\n남아 있는가?", "dec", 2.6, 0.7)
f.node("p5", 4.5, 3.2, "5 유지보수\n결함 수정, 규칙 보강, 문서 갱신, 결과보고서", "proc", 5.4)
f.node("p6", 4.5, 1.95, "발표자료 정리, 시연 리허설", "proc", 4.4)
f.node("e", 4.5, 0.85, "최종 발표 (2026-12-30)", "term", 3.2, 0.7)
for a, b in [("s", "p1"), ("p1", "p2"), ("p2", "p3"), ("p3", "p4"), ("p4", "d1")]:
    f.arrow(a, "b", b, "t")
f.arrow("d1", "b", "p5", "t", "아니오")
f.arrow("d1", "r", "p3", "r", "예 → 구현으로 수정", via=[(7.9, 4.7), (7.9, 7.5)], color=RED)
f.arrow("p5", "b", "p6", "t"); f.arrow("p6", "b", "e", "t")
f.save("flow-dev.png", "개발 절차 순서도 (기획 → 설계 → 분석·구현 → 테스트 → 유지보수)")

# ── 2) 프로그램 처리 순서도 (한 장, 2열) ──────────────────────────────
g = Flow(10.4, 13.9, y0=-1.6)
# 왼쪽 열
g.node("s", 2.4, 12.2, "시작", "term", 2.0, 0.6)
g.node("in", 2.4, 11.2, "회의 음성 또는 글 대본 입력\n(제목·회의 날짜)", "io", 3.4, 0.75)
g.node("d1", 2.4, 9.7, "형식·크기·길이\n검사 통과?", "dec", 2.4, 0.7)
g.node("d2", 2.4, 8.2, "음성 파일인가?", "dec", 2.4, 0.7)
g.node("txt", 2.4, 6.8, "글 대본 파싱\n(txt·srt·vtt, 화자·시각 분리)", "proc", 3.8, 0.75)
g.node("seg", 2.4, 5.5, "구간(segment) 목록 생성\n+ 개인정보 마스킹", "proc", 3.7, 0.75)
g.node("rules", 2.4, 4.2, "규칙 추출: 결정·할 일·미결\n기한 계산(다음 주 금요일 → 날짜)", "proc", 3.9, 0.8)
g.node("sv", 2.4, 1.9, "DB 저장 + 화면 표시\n(항목 ↔ 근거 구간 연결)", "proc", 3.7, 0.75)
g.node("cor", 2.4, 0.5, "받아쓰기 오류를\n고칠까?", "dec", 2.4, 0.65)
g.node("e", 2.4, -0.9, "끝", "term", 1.8, 0.6)
# 오른쪽 열
g.node("cv", 7.2, 8.2, "ffmpeg 변환\n(16kHz 모노 wav)", "proc", 3.0, 0.7)
g.node("wh", 7.2, 6.9, "Whisper 받아쓰기\n(내 PC, 외부 전송 없음)", "proc", 3.3, 0.7)
g.node("del", 7.2, 5.6, "음성 파일 즉시 삭제\n(텍스트만 보관)", "proc", 3.2, 0.7)
g.node("ai", 7.2, 4.2, "AI(LLM) 사용 가능?", "dec", 2.4, 0.65)
g.node("lv", 7.2, 3.0, "AI 제안 → 검증\n(근거·숫자·담당자 확인)\n기한은 코드가 다시 계산", "proc", 3.6, 0.95)
g.node("sm", 7.2, 1.7, "요약 생성\n검증 통과 시 AI 요약,\n아니면 원문 발췌", "proc", 3.6, 0.95)

g.arrow("s", "b", "in", "t")
g.arrow("in", "b", "d1", "t")
g.arrow("d1", "b", "d2", "t", "예")
g.arrow("d1", "l", "in", "l", "아니오", via=[(0.2, 9.7), (0.2, 11.2)])
g.ax.text(-0.15, 10.45, "오류 안내 후\n다시 입력", fontsize=9.5, color=RED, ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=7)
g.arrow("d2", "r", "cv", "l", "예")
g.arrow("d2", "b", "txt", "t", "아니오")
g.arrow("cv", "b", "wh", "t"); g.arrow("wh", "b", "del", "t")
g.arrow("del", "b", "seg", "r", via=[(7.2, 5.5 + 0.0)])
g.arrow("txt", "b", "seg", "t"); g.arrow("seg", "b", "rules", "t")
g.arrow("rules", "r", "ai", "l")
g.arrow("ai", "b", "lv", "t", "예")
g.arrow("ai", "r", "sm", "r", "아니오", via=[(9.6, 4.2), (9.6, 1.7)])
g.arrow("lv", "b", "sm", "t")
g.arrow("sm", "l", "sv", "r", via=[(5.0, 1.7), (5.0, 1.9)])
g.arrow("sv", "b", "cor", "t")
g.arrow("cor", "b", "e", "t", "아니오")
g.arrow("cor", "l", "rules", "l", via=[(0.2, 0.5), (0.2, 4.2)], color=RED)
g.ax.text(-0.15, 2.4, "예: 문장 수정\n후 다시 정리", fontsize=9.5, color=RED, ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=7)
g.save("flow-system.png", "MeetMate 프로그램 처리 순서도")
