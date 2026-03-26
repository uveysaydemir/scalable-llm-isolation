from typing import List

#A prompt builder for fetching user memories from mem0 instance
def build_prompt(user_prompt: str, memories: List[str]) -> str:
    if not memories:
        return user_prompt

    memory_block = "\n".join(f"- {m}" for m in memories)

    return f"""
You are a helpful assistant.

Relevant long-term user memories:
{memory_block}

User request:
{user_prompt}

Answer:
""".strip()