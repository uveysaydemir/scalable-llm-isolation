import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.prompt_builder import build_messages, build_prompt  # noqa: E402


class PromptBuilderTests(unittest.TestCase):
    def test_build_messages_includes_system_memory_history_and_user(self) -> None:
        messages = build_messages(
            user_prompt="What should I eat?",
            memories=["User is vegetarian."],
            history=[
                {"role": "user", "content": "I am hungry."},
                {"role": "assistant", "content": "What do you like?"},
            ],
        )

        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("helpful assistant", messages[0]["content"])
        self.assertEqual(messages[1]["role"], "system")
        self.assertIn("vegetarian", messages[1]["content"])
        self.assertEqual(messages[2]["role"], "user")
        self.assertEqual(messages[3]["role"], "assistant")
        self.assertEqual(messages[-1], {"role": "user", "content": "What should I eat?"})

    def test_build_prompt_keeps_fallback_plain_text_format(self) -> None:
        prompt = build_prompt(
            user_prompt="Summarize this.",
            memories=["User likes short summaries."],
            history=[{"role": "assistant", "content": "Ready when you are."}],
        )

        self.assertIn("System: You are a helpful assistant.", prompt)
        self.assertIn("Relevant long-term user memories", prompt)
        self.assertIn("Assistant: Ready when you are.", prompt)
        self.assertTrue(prompt.endswith("Assistant:"))


if __name__ == "__main__":
    unittest.main()
