from typing import List, Optional


def build_prompt(
    user_prompt: str,
    memories: List[str],
    history: Optional[List[dict]] = None,
) -> str:
    has_context = bool(memories) or bool(history)

    if not has_context:
        return user_prompt

    parts = ["You are a helpful assistant.\n"]

    if memories:
        memory_block = "\n".join(f"- {m}" for m in memories)
        parts.append(f"Relevant long-term user memories:\n{memory_block}\n")

    if history:
        conversation = "\n".join(
            f"{msg['role'].capitalize()}: {msg['content']}" for msg in history
        )
        parts.append(f"Conversation history:\n{conversation}\n")

    parts.append(f"User request:\n{user_prompt}\n\nAnswer:")

    return "\n".join(parts).strip()
