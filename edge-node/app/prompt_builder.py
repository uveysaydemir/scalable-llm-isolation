from typing import List, Optional


def build_messages(
    user_prompt: str,
    memories: List[str],
    history: Optional[List[dict]] = None,
) -> List[dict]:
    messages: List[dict] = [
        {"role": "system", "content": "You are a helpful assistant."}
    ]

    if memories:
        memory_block = "\n".join(f"- {m}" for m in memories)
        messages.append(
            {
                "role": "system",
                "content": f"Relevant long-term user memories:\n{memory_block}",
            }
        )

    if history:
        messages.extend(
            {
                "role": msg["role"],
                "content": msg["content"],
            }
            for msg in history
            if msg.get("role") in {"user", "assistant"} and msg.get("content")
        )

    messages.append({"role": "user", "content": user_prompt})
    return messages


def build_prompt(
    user_prompt: str,
    memories: List[str],
    history: Optional[List[dict]] = None,
) -> str:
    messages = build_messages(
        user_prompt=user_prompt,
        memories=memories,
        history=history,
    )

    lines = []
    for message in messages:
        role = message["role"].capitalize()
        lines.append(f"{role}: {message['content']}")

    lines.append("Assistant:")
    return "\n\n".join(lines)
