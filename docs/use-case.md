# Use case and business case

## Problem
Small trade businesses lose urgent after-hours calls to voicemail or to an owner woken at night for non-urgent jobs. The business needs two things: never miss a true emergency, and not dispatch a technician for something that can wait.

## Solution
Voice assistant that triages, captures details, reserves an on-call technician and records the job. Scope: plumbing, electrical, gas, HVAC.

## Benefit model (formula, inputs are the business's own)
- Value per month = (missed urgent calls recovered per month x average job value x margin) + (owner or technician hours saved on non-urgent calls x hourly cost) - (assistant running cost + review time).
- Inputs come from the business's call log. No vendor statistics are used as inputs; any vendor figures are directional only.

## Risks
- Safety wording must be signed off by a licensed tradesperson.
- A wrong triage costs a callout (false alarm) or a delayed emergency (false negative). Triage is tested with a golden set (planned).
- Calls must hand off to a human if the assistant fails (Fallback node).
