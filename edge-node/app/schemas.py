from datetime import datetime
from pydantic import BaseModel, Field
from typing import Literal, Optional, Union


TimestampInput = Union[datetime, float, int, str]
MovementDirection = Literal["left", "right"]


class GenerateRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: Optional[str] = Field(default=None, min_length=1)
    lastMessageTimestamp: Optional[TimestampInput] = None
    clientDirection: Optional[MovementDirection] = None
    clientSpeed: Optional[float] = Field(default=None, ge=0)
    prompt: str = Field(..., min_length=1)
    maxNewTokens: Optional[int] = 64


class GenerateResponse(BaseModel):
    ok: bool
    userId: str
    sessionId: str
    output: str
    metrics: dict


class MemoryAddRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    userMessage: str = Field(..., min_length=1)
    assistantMessage: str = Field(..., min_length=1)


class RuntimeSettingsRequest(BaseModel):
    sessionTtlSeconds: int = Field(..., ge=1)
    ltmCacheTtlSeconds: int = Field(..., ge=1)


class HandoverDecisionRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: Optional[str] = Field(default=None, min_length=1)
    lastMessageTimestamp: Optional[TimestampInput] = None


class HandoverPackageRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)
    sourceEdgeId: str = Field(..., min_length=1)
    targetEdgeId: str = Field(..., min_length=1)
    transferReason: str = Field(..., min_length=1)
    clientDirection: Optional[MovementDirection] = None
    clientSpeed: Optional[float] = Field(default=None, ge=0)
    stm: Optional[dict] = None
    ltm: list[str] = Field(default_factory=list)


class HandoverExportRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)
    targetEdgeId: str = Field(..., min_length=1)


class SessionEndRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)
