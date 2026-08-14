from types import SimpleNamespace

from browser.profile_manager import ProfileManager


def test_1688_login_stops_daemon_forces_headed_login_and_restarts(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("browser.profile_manager.os.path.exists", lambda path: True)
    monkeypatch.setattr("browser.profile_manager.subprocess.run", fake_run)

    assert ProfileManager.launch_login_browser("1688") == "SUCCESS"
    assert calls[0][0][2:] == ["daemon", "stop", "--profile", "default"]
    assert calls[1][0][2:] == [
        "login", "--profile", "default", "--headed", "--force",
        "--timeout", "300", "--no-daemon",
    ]
    assert calls[2][0][2:] == ["daemon", "start", "--profile", "default"]
    assert all(kwargs["shell"] is False for _, kwargs in calls)


def test_1688_failed_login_does_not_start_daemon_or_wrong_profile(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=130 if "login" in command else 0)

    monkeypatch.setattr("browser.profile_manager.os.path.exists", lambda path: True)
    monkeypatch.setattr("browser.profile_manager.subprocess.run", fake_run)

    assert ProfileManager.launch_login_browser("1688") is None
    assert len(calls) == 2
    assert "--headed" in calls[1]


def test_cookie_file_is_written_atomically(tmp_path):
    target = tmp_path / "cookies" / "taobao.json"
    ProfileManager._write_cookie_file(str(target), {"cookie2": "secret"})

    assert target.read_text(encoding="utf-8") == '{"cookie2": "secret"}'
    assert not (tmp_path / "cookies" / "taobao.json.tmp").exists()


def test_jd_login_routes_to_dedicated_profile(monkeypatch):
    captured = []
    monkeypatch.setattr(
        ProfileManager,
        "_launch_jd_login",
        lambda pdir: captured.append(pdir) or "SUCCESS",
    )

    assert ProfileManager.launch_login_browser("jd") == "SUCCESS"
    assert captured[0].endswith("jd_profile")


def test_misumi_login_routes_to_dedicated_profile(monkeypatch):
    captured = []
    monkeypatch.setattr(
        ProfileManager,
        "_launch_misumi_login",
        lambda pdir: captured.append(pdir) or "SUCCESS",
    )

    assert ProfileManager.launch_login_browser("misumi") == "SUCCESS"
    assert captured[0].endswith("misumi_profile")
