"""GPT Researcher runner: query -> cited research report as JSON.

Invoked by ai-web-chat-mcp-server's `research` tool. All configuration
arrives via environment variables set by the spawning server:
RETRIEVER=duckduckgo (no key), LLM via any OpenAI-compatible endpoint
(OPENAI_BASE_URL + OPENAI_API_KEY + SMART_LLM/FAST_LLM), and local
HuggingFace embeddings so no embedding API is required.
"""
import asyncio
import json
import sys


async def main() -> None:
	from gpt_researcher import GPTResearcher

	query = sys.argv[1]
	report_type = sys.argv[2] if len(sys.argv) > 2 else "research_report"
	researcher = GPTResearcher(query=query, report_type=report_type)
	await researcher.conduct_research()
	report = await researcher.write_report()
	sources: list[dict[str, str]] = []
	try:
		for source in researcher.get_research_sources():
			sources.append({"title": source.get("title", ""), "url": source.get("url", "")})
	except Exception:
		pass
	print(json.dumps({"query": query, "report": report, "sources": sources}, ensure_ascii=False, default=str))


asyncio.run(main())
