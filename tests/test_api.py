from fastapi.testclient import TestClient
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db
from backend.main import app
from backend import main as main_module


def test_inquiry_metadata_and_unicode_excel_download():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session = sessionmaker(bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/inquire",
                json={
                    "brand": "欧姆龙",
                    "model": "E3Z-D61",
                    "quantity": 1,
                    "platforms": ["1688"],
                    "force_mock": True,
                },
            )
            assert response.status_code == 200
            data = response.json()
            assert data["data_source"] == "MOCK"
            assert data["warning"]
            visible_count = sum(
                len(data[key])
                for key in (
                    "exact_matches",
                    "possible_matches",
                    "replacement_matches",
                    "other_matches",
                )
            )
            assert visible_count == data["total_count"]
            assert data["other_matches"]

            export = client.get(f"/api/export/{data['history_id']}")
            assert export.status_code == 200
            assert export.content.startswith(b"PK")
            disposition = export.headers["content-disposition"]
            assert "filename*=UTF-8''" in disposition
            assert "%E6%AC%A7%E5%A7%86%E9%BE%99" in disposition
    finally:
        app.dependency_overrides.clear()


def test_inquiry_rejects_non_positive_quantity():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={"brand": "SKF", "model": "6205", "quantity": 0},
        )
    assert response.status_code == 422


def test_login_endpoint_launches_unbuffered_helper_in_project_directory():
    with patch.dict(main_module._login_processes, {}, clear=True):
        with patch("backend.main.subprocess.Popen") as popen:
            with TestClient(app) as client:
                response = client.post("/api/auth/login/1688")

    assert response.status_code == 200
    command = popen.call_args.args[0]
    options = popen.call_args.kwargs
    assert command[1] == "-u"
    assert command[-1] == "1688"
    assert options["cwd"].endswith("bijia")


def test_login_endpoint_returns_remote_viewer_and_status():
    with patch.dict(main_module._login_processes, {}, clear=True):
        with patch.dict("os.environ", {"REMOTE_BROWSER_URL": "/remote-browser/vnc.html"}):
            with patch("backend.main.subprocess.Popen") as popen:
                popen.return_value.poll.return_value = None
                with TestClient(app) as client:
                    launched = client.post("/api/auth/login/taobao")
                    status = client.get("/api/auth/login/taobao/status")

    assert launched.status_code == 200
    assert launched.json()["viewer_url"] == "/remote-browser/vnc.html"
    assert status.json()["status"] == "running"


def test_login_endpoint_prevents_overlapping_remote_browsers():
    running_process = type("RunningProcess", (), {"poll": lambda self: None})()
    with patch.dict(main_module._login_processes, {"1688": running_process}, clear=True):
        with TestClient(app) as client:
            response = client.post("/api/auth/login/jd")

    assert response.status_code == 409
    assert "1688" in response.json()["detail"]


def test_login_endpoint_rejects_unknown_platform():
    with TestClient(app) as client:
        response = client.post("/api/auth/login/unknown")
    assert response.status_code == 400


def test_multiplatform_mock_inquiry_reports_each_platform():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "brand": "SKF",
                "model": "6205-2Z/C3",
                "quantity": 10,
                "platforms": ["1688", "taobao"],
                "force_mock": True,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 4
    assert data["data_source"] == "MULTI_PLATFORM"
    assert set(data["platform_statuses"]) == {"1688", "taobao"}
    assert data["platform_statuses"]["1688"]["result_count"] == 2
    assert data["platform_statuses"]["taobao"]["result_count"] == 2
    assert "1688" in data["warning"]
    assert "淘宝/天猫" in data["warning"]


def test_keyword_mode_and_jd_mock_are_supported():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "query_mode": "keyword",
                "keyword": "SKF 轴承",
                "quantity": 1,
                "platforms": ["1688", "taobao", "jd"],
                "force_mock": True,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["query_mode"] == "keyword"
    assert data["query_keyword"] == "SKF 轴承"
    assert data["query_brand"] == ""
    assert data["total_count"] == 6
    assert set(data["platform_statuses"]) == {"1688", "taobao", "jd"}
    assert all(item["match_level"] == "HIGH" for item in data["exact_matches"])


def test_keyword_mode_rejects_empty_keyword():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={"query_mode": "keyword", "keyword": "   ", "platforms": ["jd"]},
        )
    assert response.status_code == 400


def test_jd_login_endpoint_is_available():
    with patch.dict(main_module._login_processes, {}, clear=True):
        with patch("backend.main.subprocess.Popen") as popen:
            with TestClient(app) as client:
                response = client.post("/api/auth/login/jd")

    assert response.status_code == 200
    assert popen.call_args.args[0][-1] == "jd"


def test_phase4_four_platform_mock_inquiry():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "brand": "SKF",
                "model": "6205-2Z/C3",
                "platforms": ["1688", "taobao", "jd", "misumi"],
                "force_mock": True,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 8
    assert set(data["platform_statuses"]) == {"1688", "taobao", "jd", "misumi"}
    assert data["platform_statuses"]["misumi"]["result_count"] == 2


def test_per_platform_candidate_limit_reports_raw_and_selected_counts():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "brand": "SKF",
                "model": "6205-2Z/C3",
                "platforms": ["1688", "taobao", "jd"],
                "force_mock": True,
                "result_mode": "per_platform",
                "result_limit": 1,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 3
    assert data["result_mode"] == "per_platform"
    assert data["result_limit"] == 1
    for status in data["platform_statuses"].values():
        assert status["raw_result_count"] == 2
        assert status["selected_count"] == 1


def test_global_confidence_limit_selects_top_n_across_platforms():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "brand": "SKF",
                "model": "6205-2Z/C3",
                "platforms": ["1688", "taobao", "jd"],
                "force_mock": True,
                "result_mode": "global",
                "result_limit": 2,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 2
    assert data["result_mode"] == "global"
    assert data["result_limit"] == 2
    selected = data["exact_matches"] + data["possible_matches"] + data["replacement_matches"] + data["other_matches"]
    assert [row["match_score"] for row in selected] == sorted(
        [row["match_score"] for row in selected], reverse=True
    )


def test_candidate_limit_validation():
    with TestClient(app) as client:
        response = client.post(
            "/api/inquire",
            json={
                "brand": "SKF", "model": "6205", "platforms": ["jd"],
                "result_limit": 51,
            },
        )
    assert response.status_code == 422


def test_misumi_login_endpoint_is_available():
    with patch.dict(main_module._login_processes, {}, clear=True):
        with patch("backend.main.subprocess.Popen") as popen:
            with TestClient(app) as client:
                response = client.post("/api/auth/login/misumi")

    assert response.status_code == 200
    assert popen.call_args.args[0][-1] == "misumi"
