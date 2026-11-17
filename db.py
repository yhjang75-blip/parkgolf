"""회원·게시판·포인트·혜택 자료 보관 (SQLAlchemy Core).

- 환경변수 DATABASE_URL 이 있으면 그 데이터베이스(Neon Postgres 등)를 쓴다.
- 없으면 내 PC 시험용으로 data/community.db (SQLite) 를 쓴다.
- Render 같은 공개 서버에서 DATABASE_URL 이 없으면 커뮤니티 기능을 끈다
  (무료 서버는 다시 시작할 때 파일이 지워져 회원·글이 사라지므로).
"""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import (Boolean, Column, ForeignKey, Integer, LargeBinary, MetaData, String, Table, Text, UniqueConstraint,
                        create_engine, func, select)

KST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent

import logging
import re

log = logging.getLogger("db")

# 붙여 넣은 값에 psql '...' 이나 따옴표·공백이 섞여 있어도 주소만 골라 쓴다
_raw = os.environ.get("DATABASE_URL", "").strip()
_m = re.search(r"postgres(?:ql)?://[^\s'\"]+", _raw)
url = _m.group(0) if _m else ""
if _raw and not url:
    log.error("DATABASE_URL 값에서 postgresql:// 주소를 찾지 못했습니다. 값 앞부분: %r", _raw[:15])
if url.startswith("postgres://"):
    url = "postgresql://" + url[len("postgres://"):]
if url.startswith("postgresql://"):
    url = "postgresql+psycopg://" + url[len("postgresql://"):]

ON_SERVER = bool(os.environ.get("RENDER") or os.environ.get("CLOUDFLARE"))  # Render 또는 Cloudflare 서버에서 실행 중
ENABLED = bool(url) or not ON_SERVER
if not url:
    url = f"sqlite:///{ROOT / 'data' / 'community.db'}"

engine = create_engine(url, pool_pre_ping=True, pool_recycle=300, future=True) if ENABLED else None
md = MetaData()


def now():
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def today():
    return datetime.now(KST).strftime("%Y-%m-%d")


users = Table(
    "users", md,
    Column("id", Integer, primary_key=True),
    Column("kakao_id", String(40), unique=True, nullable=False),
    Column("nickname", String(40), nullable=False),
    Column("profile_img", String(500)),
    Column("points", Integer, nullable=False, default=0),   # 쓸 수 있는 포인트 (혜택 교환 시 줄어듦)
    Column("earned", Integer, nullable=False, default=0),   # 지금까지 모은 포인트 (등급 기준, 줄지 않음)
    Column("fav_sido", String(20)),
    Column("fav_sigungu", String(20)),
    Column("agreed_at", String(19)),       # 약관·개인정보 동의 시각
    Column("marketing", Boolean, default=False),  # 혜택 소식 수신 동의
    Column("last_attend", String(10)),     # 마지막 출석일
    Column("banned", Boolean, default=False),
    Column("created_at", String(19), nullable=False),
)

favorites = Table(
    "favorites", md,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("course_id", String(20), primary_key=True),
    Column("created_at", String(19), nullable=False),
)

posts = Table(
    "posts", md,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("category", String(20), nullable=False, index=True),
    Column("title", String(120), nullable=False),
    Column("body", Text, nullable=False),
    Column("course_id", String(20), index=True),
    Column("views", Integer, nullable=False, default=0),
    Column("likes", Integer, nullable=False, default=0),
    Column("comments", Integer, nullable=False, default=0),
    Column("photos", Integer, nullable=False, default=0),
    Column("hidden", Boolean, nullable=False, default=False),
    Column("reports", Integer, nullable=False, default=0),
    Column("created_at", String(19), nullable=False, index=True),
    Column("updated_at", String(19)),
)

images = Table(
    "images", md,
    Column("id", Integer, primary_key=True),
    Column("post_id", Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("data", LargeBinary, nullable=False),   # 긴 변 1280px JPEG
    Column("thumb", LargeBinary, nullable=False),  # 긴 변 480px JPEG
    Column("width", Integer), Column("height", Integer),
    Column("created_at", String(19), nullable=False),
)

comments = Table(
    "comments", md,
    Column("id", Integer, primary_key=True),
    Column("post_id", Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("body", Text, nullable=False),
    Column("hidden", Boolean, nullable=False, default=False),
    Column("created_at", String(19), nullable=False),
)

likes = Table(
    "likes", md,
    Column("post_id", Integer, ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)

reports = Table(
    "reports", md,
    Column("id", Integer, primary_key=True),
    Column("kind", String(10), nullable=False),  # post | comment
    Column("target_id", Integer, nullable=False),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("reason", String(200)),
    Column("done", Boolean, nullable=False, default=False),
    Column("created_at", String(19), nullable=False),
)

point_log = Table(
    "point_log", md,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("delta", Integer, nullable=False),
    Column("reason", String(40), nullable=False),
    Column("day", String(10), nullable=False, index=True),
    Column("created_at", String(19), nullable=False),
)

benefits = Table(
    "benefits", md,
    Column("id", Integer, primary_key=True),
    Column("partner", String(60), nullable=False),
    Column("title", String(120), nullable=False),
    Column("description", Text),
    Column("cost", Integer, nullable=False),          # 필요 포인트
    Column("min_grade", Integer, nullable=False, default=0),  # 필요 등급 (0~4)
    Column("stock", Integer),                          # 남은 수량 (비우면 무제한)
    Column("active", Boolean, nullable=False, default=True),
    Column("created_at", String(19), nullable=False),
)

redemptions = Table(
    "redemptions", md,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("benefit_id", Integer, ForeignKey("benefits.id"), nullable=False),
    Column("cost", Integer, nullable=False),
    Column("contact", String(100)),     # 받을 연락처 (지급 후 지움)
    Column("status", String(10), nullable=False, default="신청"),  # 신청 | 지급완료 | 취소
    Column("created_at", String(19), nullable=False),
    Column("done_at", String(19)),
)


# ---------------------------------------------------------------- 대회 참가 (compete.py)
comps = Table(
    "comps", md,
    Column("id", Integer, primary_key=True),
    Column("title", String(120), nullable=False),
    Column("play_date", String(10), nullable=False),      # 대회일 YYYY-MM-DD
    Column("open_date", String(10), nullable=False),      # 접수 시작일
    Column("close_date", String(10), nullable=False),     # 접수 마감일
    Column("venue", String(120), nullable=False),         # 장소 (구장 이름)
    Column("course_id", String(20)),                      # 구장 자료와 연결 (선택)
    Column("host", String(120)),                          # 주최·주관
    Column("contact", String(120)),                       # 문의처
    Column("divisions", String(200), nullable=False),     # 참가 부문, 쉼표 구분 (예: 남자부,여자부,시니어부)
    Column("fee", Integer, nullable=False, default=0),    # 참가비 (원)
    Column("pay_info", String(300)),                      # 입금 안내 (계좌 등, 주최자가 입력)
    Column("capacity", Integer, nullable=False, default=0),  # 정원 (0 = 제한 없음)
    Column("play_courses", String(40), nullable=False, default="A,B,C,D"),  # 경기 코스 (각 9홀)
    Column("group_size", Integer, nullable=False, default=4),
    Column("start_time", String(5), nullable=False, default="08:00"),
    Column("wave_gap", Integer, nullable=False, default=30),  # 출발 순서가 밀릴 때 간격 (분)
    Column("format", String(200)),                        # 경기 방식 설명
    Column("body", Text),                                 # 대회 요강·유의사항
    Column("closed", Boolean, nullable=False, default=False),       # 조기 마감
    Column("groups_open", Boolean, nullable=False, default=False),  # 조편성 공개
    Column("results_open", Boolean, nullable=False, default=False), # 결과 공개
    Column("hidden", Boolean, nullable=False, default=False),       # 목록에서 숨김 (준비 중)
    Column("created_at", String(19), nullable=False),
)

entries = Table(
    "entries", md,
    Column("id", Integer, primary_key=True),
    Column("comp_id", Integer, ForeignKey("comps.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("name", String(30), nullable=False),
    Column("phone", String(20), nullable=False),
    Column("gender", String(4), nullable=False),
    Column("birth_year", Integer),
    Column("club", String(60)),                           # 소속 클럽·협회
    Column("division", String(40), nullable=False),
    Column("memo", String(300)),
    Column("status", String(10), nullable=False, default="신청"),  # 신청 | 입금확인 | 취소요청 | 취소
    Column("group_no", Integer),                          # 조 번호
    Column("start_spot", String(10)),                     # 출발 위치 (예: A-3 = A코스 3번홀)
    Column("tee_time", String(5)),
    Column("scores", String(80)),                         # 코스별 타수, 쉼표 구분
    Column("total", Integer),
    Column("rank", Integer),
    Column("created_at", String(19), nullable=False),
    Column("paid_at", String(19)),
    UniqueConstraint("comp_id", "user_id", name="uq_entry_user"),
)


def init():
    """표를 만든다. 접속에 실패하면 사이트는 그대로 두고 회원 기능만 끈다 (로그에 이유를 남김)."""
    global engine, ENABLED
    if engine is None:
        log.warning("회원 기능 꺼짐: DATABASE_URL 이 없습니다.")
        return
    try:
        md.create_all(engine)
        log.warning("데이터베이스 연결 성공: %s", engine.url.host)
    except Exception as e:  # 잘못된 주소·비밀번호 등
        log.error("데이터베이스 연결 실패 (회원 기능 꺼짐): %s", str(e).splitlines()[0][:200])
        engine, ENABLED = None, False


def one(stmt):
    with engine.connect() as c:
        r = c.execute(stmt).mappings().first()
        return dict(r) if r else None


def all_(stmt):
    with engine.connect() as c:
        return [dict(r) for r in c.execute(stmt).mappings()]


def scalar(stmt):
    with engine.connect() as c:
        return c.execute(stmt).scalar()


__all__ = ["engine", "ENABLED", "init", "one", "all_", "scalar", "now", "today", "func", "select",
           "users", "favorites", "posts", "images", "comments", "likes", "reports", "point_log",
           "benefits", "redemptions", "comps", "entries"]
