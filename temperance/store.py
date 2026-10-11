"""Persistent configuration and coarse DNS activity accounting."""
import ipaddress
import json
import sqlite3
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

CATEGORIES = {
    "social": ["facebook.com", "instagram.com", "tiktok.com", "reddit.com", "x.com"],
    "video": ["youtube.com", "youtu.be", "netflix.com", "twitch.tv"],
    "gaming": ["roblox.com", "epicgames.com", "steampowered.com"],
}


def domain(value):
    value = str(value).strip().rstrip(".").lower()
    try:
        value = value.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("Invalid domain") from exc
    if not value or len(value) > 253 or any(
        not part or len(part) > 63 or part.startswith("-") or part.endswith("-")
        or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in part)
        for part in value.split(".")
    ):
        raise ValueError("Enter a domain such as example.com, without a URL or wildcard")
    return value


def matches(host, rule):
    return host == rule or host.endswith("." + rule)


def validate_profile(data):
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 60:
        raise ValueError("Name must contain 1–60 characters")
    limit = data.get("limit", 0)
    if type(limit) is not int or not 0 <= limit <= 1440:
        raise ValueError("Daily limit must be an integer from 0 to 1440; 0 is unlimited")
    categories = data.get("categories", [])
    if not isinstance(categories, list) or any(c not in CATEGORIES for c in categories):
        raise ValueError("Unknown category")
    lists = {}
    for key in ("allow", "deny"):
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > 500:
            raise ValueError("Domain lists must contain at most 500 entries")
        lists[key] = sorted(set(domain(v) for v in values))
    bedtime = data.get("bedtime", {})
    if not isinstance(bedtime, dict):
        raise ValueError("Invalid bedtime")
    start, end = bedtime.get("start", ""), bedtime.get("end", "")
    for value in (start, end):
        if value:
            try:
                if datetime.strptime(value, "%H:%M").strftime("%H:%M") != value:
                    raise ValueError()
            except (ValueError, TypeError):
                raise ValueError("Bedtime must use HH:MM") from None
    if bool(start) != bool(end) or (start and start == end):
        raise ValueError("Set two different bedtime times, or leave both empty")
    paused = data.get("paused", False)
    if type(paused) is not bool:
        raise ValueError("Paused must be a boolean")
    return dict(name=name, limit=limit, paused=paused, categories=categories,
                bedtime=dict(start=start, end=end), **lists)


class Store:
    def __init__(self, path, timezone="UTC"):
        self.zone = ZoneInfo(timezone)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY, config TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS devices(ip TEXT PRIMARY KEY, name TEXT NOT NULL,
                profile_id INTEGER REFERENCES profiles(id));
            CREATE TABLE IF NOT EXISTS activity(profile_id INTEGER, day TEXT, minute INTEGER,
                PRIMARY KEY(profile_id, day, minute));
            CREATE TABLE IF NOT EXISTS queries(id INTEGER PRIMARY KEY, at REAL, day TEXT,
                ip TEXT, profile_id INTEGER, domain TEXT, blocked INTEGER, reason TEXT);
            CREATE INDEX IF NOT EXISTS queries_day ON queries(day);
        """)

    def day(self, now):
        return datetime.fromtimestamp(now, self.zone).strftime("%Y-%m-%d")

    def profile(self, profile_id):
        row = self.db.execute("SELECT config FROM profiles WHERE id=?", (profile_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_profile(self, data):
        config = validate_profile(data)
        profile_id = data.get("id")
        with self.lock, self.db:
            if profile_id is None:
                return self.db.execute("INSERT INTO profiles(config) VALUES (?)", (json.dumps(config),)).lastrowid
            if type(profile_id) is not int or not self.profile(profile_id):
                raise ValueError("Profile does not exist")
            self.db.execute("UPDATE profiles SET config=? WHERE id=?", (json.dumps(config), profile_id))
            return profile_id

    def save_device(self, data):
        try:
            ip = str(ipaddress.IPv4Address(data.get("ip", "")))
        except ipaddress.AddressValueError:
            raise ValueError("Enter an IPv4 address") from None
        name = str(data.get("name", "")).strip()
        profile_id = data.get("profile_id")
        if not name or len(name) > 80:
            raise ValueError("Device name must contain 1–80 characters")
        with self.lock, self.db:
            if profile_id is not None and (type(profile_id) is not int or not self.profile(profile_id)):
                raise ValueError("Profile does not exist")
            self.db.execute("INSERT INTO devices VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET name=excluded.name, profile_id=excluded.profile_id", (ip, name, profile_id))

    def delete_device(self, ip):
        with self.lock, self.db:
            self.db.execute("DELETE FROM devices WHERE ip=?", (ip,))

    def used(self, profile_id, day):
        return self.db.execute("SELECT count(*) FROM activity WHERE profile_id=? AND day=?", (profile_id, day)).fetchone()[0]

    def evaluate(self, ip, host, now=None):
        """Atomically decide and account. Budgets count distinct allowed DNS minutes."""
        now = time.time() if now is None else now
        day, minute = self.day(now), int(now // 60)
        with self.lock, self.db:
            device = self.db.execute("SELECT profile_id FROM devices WHERE ip=?", (ip,)).fetchone()
            pid = device[0] if device else None
            config = self.profile(pid) if pid is not None else None
            reason = "allowed"
            if config:
                clock = datetime.fromtimestamp(now, self.zone).strftime("%H:%M")
                start, end = config["bedtime"]["start"], config["bedtime"]["end"]
                asleep = bool(start and (start <= clock < end if start < end else clock >= start or clock < end))
                in_minute = self.db.execute("SELECT 1 FROM activity WHERE profile_id=? AND day=? AND minute=?", (pid, day, minute)).fetchone()
                if config["paused"]:
                    reason = "paused"
                elif asleep:
                    reason = "bedtime"
                elif config["limit"] and self.used(pid, day) >= config["limit"] and not in_minute:
                    reason = "daily limit"
                elif any(matches(host, d) for d in config["allow"]):
                    reason = "allowed"
                elif any(matches(host, d) for d in config["deny"]):
                    reason = "custom rule"
                else:
                    for category in config["categories"]:
                        if any(matches(host, d) for d in CATEGORIES[category]):
                            reason = category
                            break
            blocked = reason != "allowed"
            if config and not blocked:
                self.db.execute("INSERT OR IGNORE INTO activity VALUES (?,?,?)", (pid, day, minute))
            self.db.execute("INSERT INTO queries(at,day,ip,profile_id,domain,blocked,reason) VALUES (?,?,?,?,?,?,?)", (now, day, ip, pid, host, blocked, reason))
            return blocked, reason

    def prune(self, now=None):
        # Retain 30 days. Run periodically, not per request.
        cutoff = self.day((time.time() if now is None else now) - 30 * 86400)
        with self.lock, self.db:
            self.db.execute("DELETE FROM queries WHERE day < ?", (cutoff,))
            self.db.execute("DELETE FROM activity WHERE day < ?", (cutoff,))

    def snapshot(self, now=None):
        day = self.day(time.time() if now is None else now)
        with self.lock:
            profiles = [dict(id=r["id"], **json.loads(r["config"]), used=self.used(r["id"], day)) for r in self.db.execute("SELECT * FROM profiles ORDER BY id")]
            devices = [dict(r) for r in self.db.execute("SELECT * FROM devices ORDER BY name")]
            recent = [dict(r) for r in self.db.execute("SELECT * FROM queries WHERE day=? ORDER BY id DESC LIMIT 100", (day,))]
            total, blocked = self.db.execute("SELECT count(*), coalesce(sum(blocked),0) FROM queries WHERE day=?", (day,)).fetchone()
            return dict(day=day, timezone=str(self.zone), profiles=profiles, devices=devices,
                        recent=recent, total=total, blocked=blocked, categories=CATEGORIES)
