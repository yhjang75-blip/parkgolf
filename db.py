"""회원·게시판·포인트·혜택 자료 보관 (SQLAlchemy Core).

- 환경변수 DATABASE_URL 이 있으면 그 데이터베이스(Neon Postgres 등)를 쓴다.
- 없으면 내 PC 시험용으로 data/community.db (SQLite) 를 쓴다.
- Render 같은 공개 서버에서 DATABASE_URL 이 없으면 커뮤니티 기능을 끈다
  (무료 서버는 다시 시작할 때 파일이 지워져 회원·글이 사라지므로).
"""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import (Boolean, Column, ForeignKey, Integer, LargeBinary, MetaData, String, Table, Text,
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

ON_SERVER = bool(os.environ.get("RENDER"))
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
           "benefits", "redemptions"]
