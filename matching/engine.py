import re
from typing import Tuple, List, Dict
from matching.schemas import UnifiedQueryResult

# 品牌别名映射表 (标准化品牌名)
BRAND_ALIASES: Dict[str, str] = {
    "SKF": "SKF",
    "斯凯孚": "SKF",
    "SMC": "SMC",
    "OMRON": "OMRON",
    "欧姆龙": "OMRON",
    "THK": "THK",
    "MISUMI": "MISUMI",
    "米思米": "MISUMI",
}

def normalize_text(text: str) -> str:
    """
    第一步：标准化文本
    - 处理全角/半角
    - 大小写统一为大写
    - 消除多余空格
    - 处理中文括号为英文括号
    - 处理混淆字符 0/O, 1/I (仅用于候选匹配参考，硬核比对时区分)
    """
    if not text:
        return ""
    
    # 全角转半角
    res = []
    for char in text:
        code = ord(char)
        if code == 0x3000:
            code = 0x0020
        elif 0xFF01 <= code <= 0xFF5E:
            code -= 0xFEE0
        res.append(chr(code))
    text = "".join(res)
    
    # 中文括号转英文括号
    text = text.replace("（", "(").replace("）", ")")
    # 统一大写
    text = text.upper()
    # 规整空格
    text = re.sub(r"\s+", " ", text).strip()
    return text

def normalize_brand(brand: str) -> str:
    norm = normalize_text(brand)
    return BRAND_ALIASES.get(norm, norm)

def normalize_model(model: str) -> str:
    norm = normalize_text(model)
    # 移除非关键分隔符号差异，如 "- " -> "-"
    norm = re.sub(r"\s*([\-/\(\)])\s*", r"\1", norm)
    return norm


def evaluate_keyword_match(keyword: str, title: str) -> Tuple[str, float, List[str], bool]:
    """关键词发现模式：按关键词片段覆盖率评估相关性，不做型号后缀判定。"""
    normalized_title = normalize_text(title)
    tokens = [
        normalize_text(token)
        for token in re.split(r"[\s,，;；|/]+", keyword or "")
        if normalize_text(token)
    ]
    if not tokens:
        return "UNKNOWN", 0.0, ["关键词为空"], True

    matched = [token for token in tokens if token in normalized_title]
    coverage = len(matched) / len(tokens)
    if coverage == 1:
        return "HIGH", 90.0, ["商品标题覆盖全部关键词"], False
    if coverage >= 0.5:
        missing = [token for token in tokens if token not in matched]
        return (
            "POSSIBLE",
            round(50.0 + coverage * 30.0, 1),
            [f"仅覆盖部分关键词，未命中: {', '.join(missing)}"],
            True,
        )
    return "MISMATCH", 20.0, ["商品标题与关键词相关度较低"], True

def evaluate_model_match(
    query_brand: str,
    query_model: str,
    title: str,
    detected_brand: str = None,
    detected_model: str = None,
    sku_name: str = None
) -> Tuple[str, float, List[str], bool]:
    """
    型号匹配核心判定逻辑
    返回: (match_level, match_score, mismatch_reasons, manual_review_required)
    """
    norm_q_brand = normalize_brand(query_brand)
    norm_q_model = normalize_model(query_model)
    
    norm_d_brand = normalize_brand(detected_brand or "")
    norm_title = normalize_text(title)
    norm_sku = normalize_text(sku_name or "")
    
    reasons = []
    score = 100.0
    manual_review = False
    
    # 1. 检查标题是否包含“替代”、“适用”、“同款”、“国产”等非原装标记
    replacement_keywords = ["替代", "适用", "通用", "兼容", "同款", "国产", "拆机", "二手", "配件"]
    is_replacement = any(kw in norm_title or kw in norm_sku for kw in replacement_keywords)
    
    if is_replacement:
        reasons.append("商品标题或SKU中包含'替代/适用/国产/通用'等非原装标记")
        return "REPLACEMENT", 40.0, reasons, True

    # 2. 品牌判定
    brand_matched = False
    if norm_q_brand:
        if norm_d_brand and norm_q_brand == norm_d_brand:
            brand_matched = True
        elif norm_q_brand in norm_title:
            brand_matched = True
        else:
            score -= 30.0
            reasons.append(f"品牌不匹配: 目标[{norm_q_brand}], 页面未显著识别到")

    # 3. 型号判定
    # 提取型号的核心主体 (例如 6205-2Z/C3 的核心主体是 6205)
    model_matched = False
    if norm_q_model == normalize_model(detected_model or ""):
        model_matched = True
    elif norm_q_model in norm_title or norm_q_model in norm_sku:
        model_matched = True
    else:
        # 拆解后缀检查
        parts = re.split(r"[\-/]", norm_q_model)
        main_part = parts[0] if parts else norm_q_model
        if main_part in norm_title or main_part in norm_sku:
            score -= 25.0
            reasons.append(f"仅核心主体[{main_part}]匹配，完整后缀/游隙/密封圈参数需人工确认")
            return "POSSIBLE", score, reasons, True
        else:
            score -= 60.0
            reasons.append(f"型号主结构不一致: 目标[{norm_q_model}]")
            return "MISMATCH", min(score, 20.0), reasons, True

    # 4. 判定等级分级
    if brand_matched and model_matched:
        if norm_q_model == normalize_model(detected_model or ""):
            return "EXACT", 100.0, [], False
        else:
            return "HIGH", 90.0, ["型号通过标题/SKU匹配，无独立字段确认"], False

    return "UNKNOWN", 50.0, reasons, True
