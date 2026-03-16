from pydantic import BaseModel, Field
from typing import Optional

class GenerateRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    maxNewTokens: Optional[int] = 64

class GenerateResponse(BaseModel):
    ok: bool
    userId: str
    output: str
    metrics: dict