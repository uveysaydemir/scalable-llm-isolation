from datetime import datetime
from pydantic import BaseModel, Field
from typing import Optional, Union


TimestampInput = Union[datetime, float, int, str]


class GenerateRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: Optional[str] = Field(default=None, min_length=1)
    lastMessageTimestamp: Optional[TimestampInput] = None
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


class HandoverDecisionRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: Optional[str] = Field(default=None, min_length=1)
    lastMessageTimestamp: Optional[TimestampInput] = None
class SessionEndRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)
