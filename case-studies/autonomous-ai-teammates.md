# Case Study 2: Autonomous AI Teammates

## The Problem

Most teams waste hours every day on repetitive digital chores. Inboxes overflow, sales leads go cold, expense receipts pile up, and software bugs sit untouched. Regular AI chatbots cannot fix this because they only work when you type a prompt, they forget everything when you close the tab, and they cannot take real action inside your company apps.

## Project Goals

- **Hire Digital Coworkers:** Create specialized AI teammates that own entire jobs from start to finish, around the clock.
- **Work in Real Tools:** Connect bots directly to email, chat, code, and documents so they do real work instead of just talking.
- **Total Ownership & Safety:** Keep humans in control of big actions while running on your own servers and chosen AI models.

## What the System Does

We are building a **Mission Control** system where a team of specialized AI bots works alongside you just like human employees:

- **Give Each Bot a Specific Job:**
  - **Inbox Manager:** Sorts unread emails, archives spam, replies to routine scheduling threads, and holds important drafts for you to read.
  - **Sales Outbound:** Researches new leads, tracks quiet prospects, and queues up follow-up emails.
  - **Expense Manager:** Matches receipts to bank payments and files expense reports.
  - **Bug Triage & Coding Agent:** Reproduces reported software bugs, writes reproduction steps in GitHub issues, and makes code edits.
  - **Talent Scout:** Reviews job applications and shortlists the best candidates.
  - **Account Manager & Paid Media:** Tracks customer renewals and checks daily ad spend changes.
  - **Chief of Staff:** Prepares daily briefings and coordinates the other bots.
- **Works Inside Your Apps (MCP):** Bots connect directly to Gmail, GitHub, Notion, and custom tools, and can even use a computer screen to click and type.
- **Message Them Anywhere:** Chat with your bots in Slack, Microsoft Teams, iMessage, SMS, WhatsApp, Telegram, or a mobile app.
- **Wakes Up on Its Own:** Bots run on a schedule (like every weekday morning) or wake up automatically when a webhook fires or a new GitHub issue opens, even while your computer is turned off.
- **Learns by Watching:** Record yourself doing a task once on screen, and the bot saves those exact steps as a reusable skill.
- **Remembers & Shares Context:** Bots remember rules (like "keep replies short" or "Acme renews in March") and share that memory across the whole team.
- **Agent-to-Agent (A2A) Handoffs:** Bots pass tasks to each other and work together in groups to finish complex jobs.
- **Strict Approval Limits & Voice Calls:** You decide which actions a bot can take alone and which ones require you to click **Approve** or **Deny**. If a bot hits an urgent decision, it calls you directly in the app to talk it through.
- **Self-Hosted & Model Choice:** Run everything on your own machine or private cloud. Pick a different AI brain for each bot, including Claude, ChatGPT, Grok, or local private models with Ollama and LM Studio.

## What You Will Build in This Project

1. **Mission Control Board:** A central dashboard and task queue where you assign jobs, track progress, and approve or deny sensitive bot actions.
2. **Multi-Agent Team:** At least two specialized bots (such as an Inbox Manager and a Chief of Staff) that wake up on triggers, use real app tools, hand off tasks to each other, and save persistent memory safely.
