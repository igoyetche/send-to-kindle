# Claude Agents

This directory contains agent definitions for the send-to-kindle-mcp project. Each agent is a specialized persona that brings expert knowledge to different types of tasks.

## Available Agents

### Development & Architecture

- **[Strategic Architect](./strategic-architect.md)** (`arc`) - System design, architecture decisions, scalability
- **[Super TypeScript Developer](./super-typescript-developer.md)** (`tsc`) - TypeScript development, type safety
- **[Super TDD Developer](./super-tdd-developer.md)** (`tdd`) - Test-driven development, legacy code, refactoring
- **[Implementer](./implementer.md)** - Module implementation from design documents
- **[Reviewer](./reviewer.md)** - Implementation review against design and spec
- **[Test Writer](./test-writer.md)** - Test creation for implemented modules

### Product & Planning

- **[PRD Expert](./prd-expert.md)** (`prd`) - Product requirements, feature planning, milestones
- **[Generalist Robot](./generalist-robot.md)** (`gen`) - Research, analysis, problem-solving

### Documentation

- **[Documentation Expert](./documentation-expert.md)** (`doc`) - Technical writing, code samples, API docs

## How to Use

Each agent file contains:
- **Name & Purpose** - What the agent does
- **Critical Rules** - Non-negotiable principles
- **System Prompt** - Use this when instantiating the agent with Claude API or Agent SDK
- **Recommended Tools** - Best tools for this agent to use
- **Best For** - Tasks and use cases

### With Claude API

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    system="""You are the Strategic Architect agent...

    [Use the system prompt from the agent file]
    """,
    messages=[
        {"role": "user", "content": "Design the API structure for this feature..."}
    ]
)
```

### With Claude Agent SDK

```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Design the architecture for this system",
    options=ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep", "WebSearch"],
        system_prompt="""[Use the system prompt from the agent file]"""
    )
):
    if "result" in message:
        print(message.result)
```

## Agent Selection Guide

**Choose Strategic Architect when:**
- Designing new systems or services
- Making technology choices
- Planning scalability and resilience
- Reviewing architecture decisions

**Choose Super TypeScript Developer when:**
- Writing or reviewing TypeScript code
- Setting up type-safe projects
- Enforcing strictness and best practices
- Architecting type systems

**Choose Super TDD Developer when:**
- Working with legacy code
- Fixing bugs (test-first)
- Refactoring existing code
- Understanding unfamiliar codebases

**Choose PRD Expert when:**
- Planning new features
- Defining product requirements
- Creating milestones and deliverables
- Preparing for architecture review

**Choose Documentation Expert when:**
- Writing technical documentation
- Creating API documentation
- Reviewing documentation quality
- Testing code samples

**Choose Generalist Robot when:**
- You need analysis across domains
- Problem-solving and troubleshooting
- Research-backed recommendations
- Understanding complex systems

## Creating Custom Agents

To create new agents based on the system prompts in `@.claude/skills/system-prompts/`:

1. Read the system prompt file
2. Create a new markdown file in this directory
3. Extract the name, shortcut, and persona
4. Include the system prompt in a code block
5. Document recommended tools and best use cases

## Notes

- Each agent maintains its own specialized perspective and expertise
- Agents are designed to be used independently or in sequence
- The system prompts define how each agent approaches problems
- Tools should be selected based on the task and agent expertise
