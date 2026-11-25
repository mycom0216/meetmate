"""ERD 이미지 생성: python tools/make_erd.py  →  docs/images/erd.png
데이터정의서·기획서·발표자료에 들어가는 ERD입니다. src/db.mjs 의 SCHEMA 와 같은 구조를 손으로 옮긴 것이므로
테이블을 바꾸면 이 파일과 docs/MeetMate_데이터정의서.md 도 함께 고쳐야 합니다. (matplotlib만 사용)
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False

T = {
    "users": (0.5, 9.2, [("PK", "user_id"), ("", "created_at")]),
    "meetings": (5.6, 9.2, [("PK", "meeting_id"), ("FK", "user_id"), ("", "title"), ("", "held_at"), ("", "source (audio|text)"), ("", "duration_sec"), ("", "language"), ("", "stt_engine"), ("", "pii_found"), ("", "created_at")]),
    "segments": (11.2, 9.2, [("PK", "segment_id"), ("FK", "meeting_id"), ("UQ", "idx  (meeting_id, idx)"), ("", "start_sec"), ("", "end_sec"), ("", "speaker"), ("", "text"), ("", "edited")]),
    "summaries": (11.2, 4.2, [("PK,FK", "meeting_id"), ("", "body"), ("", "method (rule|llm)"), ("", "created_at")]),
    "items": (5.6, 3.4, [("PK", "item_id"), ("FK", "meeting_id"), ("FK", "seg_idx  → segments"), ("", "kind (decision|action|issue)"), ("", "text"), ("", "owner"), ("", "due"), ("", "due_expr"), ("", "status (open|done)"), ("", "method (rule|llm)")]),
    "feedback": (0.5, 3.4, [("PK", "feedback_id"), ("FK", "user_id"), ("FK", "item_id"), ("", "helpful"), ("", "created_at")]),
}
ROW, HEAD, W = 0.42, 0.6, 4.2
EDGE = "#0f766e"

def box(n):
    x, y, cols = T[n]
    return x, y, W, HEAD + ROW * len(cols)

fig, ax = plt.subplots(figsize=(17.5, 11.5))
ax.set_xlim(0, 17.5); ax.set_ylim(-1.6, 11.2); ax.axis("off")
ax.text(0.5, 10.7, "MeetMate ERD (SQLite, 6개 테이블)", fontsize=20, fontweight="bold", color="#1b2430")
ax.text(0.5, 10.25, "1:N 관계는 부모(1) → 자식(N). items 의 (meeting_id, seg_idx)는 segments 의 (meeting_id, idx)를 가리키는 복합 외래키(근거 구간 없는 항목 저장 불가).", fontsize=10.5, color="#667085")

def side(n, s):
    x, y, w, h = box(n)
    return {"l": (x, y - h / 2), "r": (x + w, y - h / 2), "t": (x + w / 2, y), "b": (x + w / 2, y - h)}[s]

def rel(a, sa, b, sb, via=None, one=True, dashed=False, lab=None, lab_at=None):
    p1, p2 = side(a, sa), side(b, sb)
    pts = [p1] + (via or []) + [p2]
    for i in range(len(pts) - 1):
        last = i == len(pts) - 2
        ax.annotate("", xy=pts[i + 1], xytext=pts[i], arrowprops=dict(arrowstyle="-|>" if last else "-", color="#475467", lw=1.4, shrinkA=0, shrinkB=0, linestyle="--" if dashed else "-"))
    if one:
        ax.text(p1[0] + (pts[1][0] - p1[0]) * 0.1 + 0.05, p1[1] + (pts[1][1] - p1[1]) * 0.1 + 0.12, "1", fontsize=10, color="#d92d20", fontweight="bold")
        qx, qy = pts[-2]
        ax.text(p2[0] + (qx - p2[0]) * 0.12 - 0.05, p2[1] + (qy - p2[1]) * 0.12 + 0.12, "N", fontsize=10, color="#d92d20", fontweight="bold")
    if lab:
        ax.text(lab_at[0], lab_at[1], lab, fontsize=9, color="#475467", ha="center", bbox=dict(fc="white", ec="none", pad=1), zorder=9)

rel("users", "r", "meetings", "l")
rel("users", "b", "feedback", "t")
rel("meetings", "r", "segments", "l")
rel("meetings", "r", "summaries", "l", via=[(10.5, 6.8), (10.5, 3.06)], one=False, lab="1 : 1", lab_at=(10.5, 5.0))
rel("meetings", "b", "items", "t")
rel("items", "r", "segments", "b", via=[(15.9, 1.0), (15.9, 5.0), (13.3, 5.0)], one=False, dashed=True, lab="복합 FK (meeting_id, seg_idx)", lab_at=(14.4, 1.25))
rel("items", "l", "feedback", "r")

for name, (x, y, cols) in T.items():
    h = HEAD + ROW * len(cols)
    ax.add_patch(FancyBboxPatch((x, y - h), W, h, boxstyle="round,pad=0.02,rounding_size=0.12", fc="white", ec=EDGE, lw=2, zorder=3))
    ax.add_patch(FancyBboxPatch((x, y - HEAD), W, HEAD, boxstyle="round,pad=0.02,rounding_size=0.12", fc=EDGE, ec=EDGE, lw=2, zorder=4))
    ax.text(x + W / 2, y - HEAD / 2, name, color="white", fontsize=13, fontweight="bold", ha="center", va="center", zorder=5)
    for i, (k, c) in enumerate(cols):
        yy = y - HEAD - ROW * (i + 0.5)
        if k:
            ax.text(x + 0.15, yy, k, fontsize=9, color="#b42318" if "PK" in k else "#175cd3", fontweight="bold", va="center", zorder=5)
        ax.text(x + 1.15, yy, c, fontsize=10.5, color="#1b2430", va="center", zorder=5)

out = Path(__file__).resolve().parent.parent / "docs" / "images" / "erd.png"
out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(out, dpi=110, bbox_inches="tight", facecolor="white")
print("saved", out)
