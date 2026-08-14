import os
import sys
import json
import subprocess
import threading
from urllib.parse import quote
from typing import List, Optional, Literal
from fastapi import FastAPI, Depends, HTTPException, Response, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database import engine, Base, get_db, ensure_schema_columns
from backend.models import QueryHistoryRecord, QueryResultRecord
from backend.services.query_service import QueryService
from backend.services.excel_service import generate_inquiry_excel
from matching.schemas import UnifiedQueryResult, TierPrice

# 自动创建表
Base.metadata.create_all(bind=engine)
ensure_schema_columns()

app = FastAPI(
    title="工业标准品多平台询价与供应商比价系统 API",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

query_service = QueryService()
_login_processes = {}
_login_process_lock = threading.Lock()


def _running_login():
    """Return the currently active login helper, if any."""
    for active_platform, process in _login_processes.items():
        if process.poll() is None:
            return active_platform, process
    return None, None

class InquiryRequest(BaseModel):
    query_mode: Literal["model", "keyword"] = Field("model", description="model=品牌型号严格匹配；keyword=关键词发现")
    brand: str = Field("", max_length=100, description="品牌, 如 SKF, SMC, 欧姆龙")
    model: str = Field("", max_length=200, description="完整型号, 如 6205-2Z/C3, CDQ2B32-50DMZ")
    keyword: str = Field("", max_length=300, description="关键词模式的搜索词")
    quantity: int = Field(1, ge=1, description="采购数量")
    platforms: List[Literal["1688", "taobao", "jd", "misumi"]] = Field(default=["1688"], min_length=1, description="平台选择")
    force_mock: bool = Field(False, description="是否强制使用Mock离线样本数据")
    result_mode: Literal["per_platform", "global"] = Field(
        "per_platform", description="per_platform=每平台取N条；global=全平台置信度前N条"
    )
    result_limit: int = Field(10, ge=1, le=50, description="候选结果数量")

@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "bijia-backend"}

@app.post("/api/inquire")
def run_inquiry(req: InquiryRequest, db: Session = Depends(get_db)):
    brand = req.brand.strip()
    model = req.model.strip()
    keyword = req.keyword.strip()
    if req.query_mode == "model" and (not brand or not model):
        raise HTTPException(status_code=400, detail="品牌和型号不能为空")
    if req.query_mode == "keyword" and not keyword:
        raise HTTPException(status_code=400, detail="关键词不能为空")
    
    res = query_service.execute_inquiry(
        db=db,
        query_brand=brand,
        query_model=model,
        quantity=req.quantity,
        platforms=req.platforms,
        force_mock=req.force_mock,
        query_mode=req.query_mode,
        query_keyword=keyword,
        result_mode=req.result_mode,
        result_limit=req.result_limit,
    )
    return res

@app.post("/api/auth/login/{platform}")
def trigger_manual_login(platform: str):
    """
    触发人工扫码登录。本地 Windows 使用桌面窗口，部署环境通过
    REMOTE_BROWSER_URL 把服务器上的可视化 Chrome 嵌入网页。
    """
    platform = platform.lower().strip()
    if platform not in {"1688", "taobao", "jd", "misumi"}:
        raise HTTPException(status_code=400, detail=f"暂不支持平台登录: {platform}")

    base_dir = os.path.dirname(os.path.dirname(__file__))
    script_path = os.path.join(base_dir, "scripts", "open_login_browser.py")
    viewer_url = os.getenv("REMOTE_BROWSER_URL", "").strip() or None
    try:
        with _login_process_lock:
            active_platform, _ = _running_login()
            if active_platform:
                if active_platform == platform:
                    return {
                        "status": "already_running",
                        "platform": platform,
                        "viewer_url": viewer_url,
                        "message": f"[{platform}] 登录浏览器已在运行",
                    }
                raise HTTPException(
                    status_code=409,
                    detail=f"{active_platform} 登录窗口正在运行，请先完成或关闭它",
                )

            creationflags = subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
            process = subprocess.Popen(
                [sys.executable, "-u", script_path, platform],
                cwd=base_dir,
                creationflags=creationflags,
            )
            _login_processes[platform] = process

        return {
            "status": "launched",
            "platform": platform,
            "viewer_url": viewer_url,
            "message": (
                f"已启动 [{platform}] 服务器登录浏览器"
                if viewer_url
                else f"已在桌面打开 [{platform}] 独立登录窗口"
            ),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"弹出浏览器失败: {e}")


@app.get("/api/auth/login/{platform}/status")
def get_manual_login_status(platform: str):
    platform = platform.lower().strip()
    if platform not in {"1688", "taobao", "jd", "misumi"}:
        raise HTTPException(status_code=400, detail=f"暂不支持平台登录: {platform}")

    process = _login_processes.get(platform)
    if process is None:
        return {"status": "idle", "platform": platform}
    return_code = process.poll()
    if return_code is None:
        return {"status": "running", "platform": platform}
    return {
        "status": "completed" if return_code == 0 else "failed",
        "platform": platform,
        "return_code": return_code,
    }

@app.get("/api/history")
def get_query_history(db: Session = Depends(get_db), limit: int = 20):
    records = db.query(QueryHistoryRecord).order_by(QueryHistoryRecord.created_at.desc()).limit(limit).all()
    return records

@app.get("/api/history/{history_id}")
def get_query_details(history_id: int, db: Session = Depends(get_db)):
    history = db.query(QueryHistoryRecord).filter(QueryHistoryRecord.id == history_id).first()
    if not history:
        raise HTTPException(status_code=404, detail="记录不存在")
    
    results = db.query(QueryResultRecord).filter(QueryResultRecord.history_id == history_id).all()
    return {
        "history": history,
        "results": results
    }

@app.get("/api/export/{history_id}")
def export_excel(history_id: int, db: Session = Depends(get_db)):
    history = db.query(QueryHistoryRecord).filter(QueryHistoryRecord.id == history_id).first()
    if not history:
        raise HTTPException(status_code=404, detail="记录不存在")
    
    db_results = db.query(QueryResultRecord).filter(QueryResultRecord.history_id == history_id).all()
    
    schema_results: List[UnifiedQueryResult] = []
    for r in db_results:
        tier_list = []
        if r.tier_prices_json:
            try:
                tier_list = [TierPrice(**t) for t in json.loads(r.tier_prices_json)]
            except Exception:
                pass
        
        reasons = []
        if r.mismatch_reasons_json:
            try:
                reasons = json.loads(r.mismatch_reasons_json)
            except Exception:
                pass

        schema_results.append(UnifiedQueryResult(
            platform=r.platform,
            query_brand=r.query_brand,
            query_model=r.query_model,
            normalized_brand=r.normalized_brand,
            normalized_model=r.normalized_model,
            title=r.title,
            detected_brand=r.detected_brand,
            detected_model=r.detected_model,
            sku_name=r.sku_name,
            sku_id=r.sku_id,
            supplier_name=r.supplier_name or "未知",
            legal_company_name=r.legal_company_name,
            shop_name=r.shop_name,
            supplier_location=r.supplier_location,
            supplier_years=r.supplier_years,
            supplier_type=r.supplier_type,
            official_store=r.official_store,
            authorized_supplier=r.authorized_supplier,
            original_or_replacement=r.original_or_replacement,
            currency=r.currency,
            displayed_price=r.displayed_price,
            sku_price=r.sku_price,
            unit_price=r.unit_price,
            quantity=r.quantity,
            min_order_quantity=r.min_order_quantity,
            tier_prices=tier_list,
            tax_included=r.tax_included,
            shipping_fee=r.shipping_fee,
            stock_status=r.stock_status,
            stock_quantity=r.stock_quantity,
            delivery_time=r.delivery_time,
            product_url=r.product_url,
            shop_url=r.shop_url,
            fetched_at=r.fetched_at,
            match_score=r.match_score,
            match_level=r.match_level,
            mismatch_reasons=reasons,
            manual_review_required=r.manual_review_required
        ))

    excel_bytes = generate_inquiry_excel(
        query_brand=history.query_brand,
        query_model=history.query_model,
        quantity=history.quantity,
        results=schema_results,
        query_mode=history.query_mode or "model",
        query_keyword=history.query_keyword or "",
    )

    query_label = history.query_keyword if history.query_mode == "keyword" else f"{history.query_brand}_{history.query_model}"
    filename = f"Inquiry_{query_label}.xlsx"
    encoded_filename = quote(filename, safe="")
    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
    )

frontend_dist = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "public")
if os.path.exists(frontend_dist):
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="static")
