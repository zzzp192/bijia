from typing import List, Optional, Any, Dict, Literal
from pydantic import BaseModel, Field
from datetime import datetime

class TierPrice(BaseModel):
    min_quantity: int = Field(description="阶梯起始数量")
    max_quantity: Optional[int] = Field(None, description="阶梯截止数量 (None 表示无上限)")
    unit_price: float = Field(description="该阶梯单价")

class UnifiedQueryResult(BaseModel):
    # 查询条件
    platform: Literal["1688", "taobao", "jd", "misumi"] = Field(description="平台名称")
    query_brand: str = Field(description="用户输入的品牌")
    query_model: str = Field(description="用户输入的完整型号")
    normalized_brand: str = Field(description="标准化后的品牌")
    normalized_model: str = Field(description="标准化后的完整型号")

    # 商品与SKU信息
    title: str = Field(description="商品标题")
    detected_brand: Optional[str] = Field(None, description="页面识别出的品牌")
    detected_model: Optional[str] = Field(None, description="页面识别出的型号")
    sku_name: Optional[str] = Field(None, description="具体SKU规格名称")
    sku_id: Optional[str] = Field(None, description="具体SKU ID")

    # 供应商/店铺信息
    supplier_name: str = Field(description="供应商或店铺名称")
    legal_company_name: Optional[str] = Field(None, description="企业营业执照全称")
    shop_name: Optional[str] = Field(None, description="店铺名称")
    supplier_location: Optional[str] = Field(None, description="供应商所在地")
    supplier_years: Optional[int] = Field(None, description="诚信通/入驻年限")
    supplier_type: Optional[str] = Field("未知", description="供应商类型: 厂 / 商 / 官方旗舰店 / 代理商 / 未知")
    official_store: bool = Field(False, description="是否为官方旗舰店")
    authorized_supplier: bool = Field(False, description="是否为官方授权经销商")
    original_or_replacement: Literal["ORIGINAL", "AUTHORIZED", "REPLACEMENT", "SUSPECTED_FAKE", "UNKNOWN"] = Field(
        "UNKNOWN", description="原装 / 授权 / 替代 / 疑似仿品 / 未知"
    )

    # 价格与计价方式
    currency: str = Field("CNY", description="货币符号")
    displayed_price: float = Field(description="搜索列表展示最低价")
    sku_price: Optional[float] = Field(None, description="目标型号SKU实时价格")
    unit_price: float = Field(description="询价数量对应的实际结算单价")
    quantity: int = Field(1, description="询价采购数量")
    min_order_quantity: int = Field(1, description="起订量 (MOQ)")
    tier_prices: List[TierPrice] = Field(default_factory=list, description="数量阶梯价表")
    tax_included: Optional[bool] = Field(None, description="True=含税, False=未税, None=未知")
    shipping_fee: float = Field(0.0, description="预估运费 (0.0 表示包邮)")

    # 库存与交期
    stock_status: str = Field("UNKNOWN", description="IN_STOCK / OUT_OF_STOCK / PREORDER / UNKNOWN")
    stock_quantity: Optional[int] = Field(None, description="库存数量")
    delivery_time: Optional[str] = Field(None, description="预计交期 / 发货时间")

    # 链接与抓取状态
    product_url: str = Field(description="商品原始链接")
    shop_url: Optional[str] = Field(None, description="店铺原始链接")
    fetched_at: str = Field(default_factory=lambda: datetime.now().isoformat(), description="抓取时间 ISO格式")

    # 型号匹配与评分
    match_score: float = Field(0.0, description="置信度评分 (0-100)")
    match_level: Literal["EXACT", "HIGH", "POSSIBLE", "REPLACEMENT", "MISMATCH", "UNKNOWN"] = Field(
        "UNKNOWN", description="匹配等级: EXACT / HIGH / POSSIBLE / REPLACEMENT / MISMATCH / UNKNOWN"
    )
    mismatch_reasons: List[str] = Field(default_factory=list, description="不匹配或差异原因说明")
    manual_review_required: bool = Field(True, description="是否需要人工确认")
    raw_snapshot_id: Optional[str] = Field(None, description="关联的原始页面快照/HTML数据ID")
