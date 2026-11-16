# Case Study 1: Enterprise Agentic HCP System

## The Problem

A global medicine company talks to doctors, nurses, and pharmacists (called Healthcare Professionals, or HCPs) every day. Right now, the company uses four separate computer systems that do not talk to each other:

- **Sales App (CRM):** Where sales reps write meeting notes and sample requests.
- **Email Marketing Tool:** Which sends newsletters and training programs.
- **Call Center:** Where doctors call with questions about medicine safety and doses.
- **Website & Chatbots:** Where doctors look up drug facts on their own.

Because these four systems are disconnected, big problems happen:

1. **Spamming Doctors:** A doctor gets three identical emails from different teams, plus a phone call repeating the exact same thing.
2. **Slow Answers:** A simple medical question takes days to answer because medical and legal teams have to check it by hand.
3. **Lost Notes:** Helpful notes from sales reps and call centers stay trapped in separate apps and never get shared.
4. **Compliance Risk:** Every message must use up-to-date, legally approved medical facts, but nobody can easily prove that it does.

## Project Goals

- **One Shared Profile:** Combine all notes, emails, and call records into one single 360-degree view of each doctor.
- **Fast, Safe Answers:** Answer doctor questions in minutes using only approved medical documents.
- **Proof and Control:** Keep humans in charge of risky decisions and record every step so legal teams can verify it.

## What the System Does

We are building an AI system on the cloud (AWS) that connects all four tools and uses smart agents to help staff safely:

- **Medical Question Helper:** When a doctor asks a question from any channel, an AI agent searches approved medical files and writes a draft reply. If the question is tricky or has no approved answer, the agent stops and sends it to a human medical reviewer.
- **Smart Outreach Planner:** Before a rep or marketer contacts a doctor, an agent checks what that doctor has already received or asked. It then suggests the best next step for the human rep to approve.
- **Content Fact-Checker:** When building a new email, an agent checks every single medical claim against approved source files. If any sentence is changed or unapproved, it flags it for human review.
- **Full Audit Trail:** Every draft shows the exact source file it came from, why it is safe, and which human approved it.

## Safety Rules

- **Knows When to Stop:** If the system cannot find an approved answer, it refuses to guess and hands the task to a human.
- **Country Rules:** The system checks local laws so a doctor in one country only sees content approved for that country.
- **Fake Test Data Only:** During building and testing, we only use made-up drug names and synthetic doctor profiles.

## What You Will Build in This Project

1. **The System Blueprint:** A clear diagram showing how data flows from all four apps into one brain, how permissions work, and where humans approve tasks.
2. **The Working Agent Pipeline:** Code that takes a doctor's question, checks approved documents, traces the source, and pauses for human approval before sending.
