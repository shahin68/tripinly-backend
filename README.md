# Tripinly agent package

Instructions, knowledge and skills for the agent that builds the Tripinly backend.

```
CLAUDE.md                         Agent instructions: role, stack, rules, workflow, skill index
docs/knowledge/
  01-product-brief.md             What Tripinly is, screens, features
  02-domain-rules.md              Product rules: visibility, copying, deletion, age, blocking, premium
  03-data-model.md                Tables, relations, deletion behaviour, indexes
  04-api-spec.md                  Conventions, endpoints, error codes
  05-realtime-and-notifications.md  WebSocket events, push, email
  06-architecture-and-infra.md    Processes, repo layout, libraries, env vars, Railway
  07-security-and-gdpr.md         Auth, uploads, personal data, GDPR rights
  08-decision-log.md              Decisions made so far (append-only)
  09-open-questions.md            What still needs your answer
  10-maps-places-routing.md       Google map on the client, OSM places, search, routing, along-the-way
.claude/skills/
  add-endpoint/  database-change/  trip-access/  photo-pipeline/
  realtime-event/  notifications/  geo-discovery/  account-deletion/
  moderation/  premium-feature/  deploy-railway/  osm-import/  routing/
```

## Using it with Claude Code (in the backend repo)

Copy `CLAUDE.md`, `docs/` and `.claude/` into the root of the backend repository. Claude Code reads `CLAUDE.md` automatically and picks up the skills from `.claude/skills/`. Commit them so the knowledge evolves with the code.

## Using it in a Claude project (claude.ai)

- Paste the contents of `CLAUDE.md` into the project's instructions.
- Upload the files in `docs/knowledge/` as project knowledge.
- Add each folder in `.claude/skills/` as a custom skill (zip each folder on its own).

## Keeping it current

When you and the agent make a new decision, it should update the relevant knowledge file and add a line to `08-decision-log.md`. Answer items in `09-open-questions.md` as you go; the first two block billing and the final account-deletion step.
