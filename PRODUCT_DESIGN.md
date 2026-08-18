# Hyos Product Design

## Product vision

Hyos is a mobile-first platform for creating and using personal software. A user describes an app in conversation; an agent builds it, tests it end to end, and delivers it ready to use inside Hyos. The result should feel less like programming and more like asking for a small, dependable tool made specifically for you.

Hyos is not a free-form coding sandbox. It provides an opinionated application stack, reliable primitives, prebuilt interface components, a real-time database, integrations, and controlled build-and-update workflows. Constraining the environment lets the agent produce useful software quickly while avoiding many of the failure modes common to AI-generated applications.

## The problem

Many useful software ideas are too personal or too small to justify traditional development. Existing no-code tools still require users to understand workflows, databases, interface construction, and deployment. General-purpose AI coding tools can generate code quickly, but users must often configure infrastructure, diagnose failures, and maintain the result.

Hyos closes that gap: users express intent, while the platform takes responsibility for implementation, validation, hosting, and ongoing operation.

## Target user

Hyos initially serves people who are comfortable describing systems and workflows but may not know how to build software. Technical users will be able to ask for more sophisticated behavior, but programming knowledge should never be required to get a useful result.

Early use cases are small, personal, and focused, such as:

- A daily email digest that gathers messages and prompts the user to review them at a chosen time.
- A personal budgeting tool tailored to the user's own habits.
- Lightweight tools that combine personal data, scheduled actions, and external services.

## Core product principles

### Conversation is the creation interface

Users describe the outcome they want in natural language. They should not need to assemble workflow diagrams, define database schemas, choose libraries, or configure deployment infrastructure.

### The agent owns the path to working software

Generating an app is not completion. The agent must build it, exercise it through platform-provided end-to-end workflows, resolve failures, and finish only when the app is ready to use.

### Constraints create reliability

Hyos favors a narrow, deeply integrated stack over arbitrary frameworks and infrastructure. Apps use platform-defined primitives for data, UI, integrations, scheduling, testing, and lifecycle management. These primitives are designed specifically to be used correctly by agents.

### Mobile use is the default

Most users will create, manage, and use their apps from a phone. Creation conversations, app interfaces, approvals, testing feedback, and recovery flows must all work well on small screens before being expanded for desktop.

### Personal apps live together

Hyos is the home for the apps a user creates. The personal home screen shows their apps and provides a consistent way to open, manage, update, and share them. Apps do not need to be packaged or installed independently through an app store.

### Fast, synchronized state is built in

Apps use a real-time database with fast optimistic updates as a platform primitive. The architecture should eliminate common client/server synchronization problems instead of asking each generated app to solve them independently.

### Updates must be safer than regeneration

Users can reopen an agent that understands the app and its prior conversations, then request changes. Update workflows validate behavior and database migrations for regressions. A database backup is taken before every update so the app and its data can be restored if necessary.

### Permissions stay simple and explicit

Each app receives access only to the databases it needs. The initial product will not promise granular, record-level permissions inside an app. Sharing an app means sharing access to its full database, and the interface must make that consequence unambiguous before the user proceeds.

### Portability is possible, not primary

The normal experience is to use and share apps within Hyos. Export may be available for users who want an independent application, but it is not the center of the initial product experience.

## Core experience

### 1. Start with an idea

From the Hyos home screen, the user starts a conversation and describes a desired app. The agent can ask focused follow-up questions when important behavior is ambiguous.

### 2. Build within the Hyos stack

The agent translates the request into an app using supported UI components, data primitives, integrations, and scheduled workflows. The platform handles infrastructure and deployment details.

### 3. Validate before delivery

The agent tests the complete user flows in a realistic environment. It iterates on failures without requiring the user to interpret logs or debug code.

### 4. Use the app in Hyos

Once complete, the app appears on the user's personal home screen and is immediately usable. Scheduled behaviors, such as reminders or digest generation, operate as part of the platform.

### 5. Improve through conversation

The user can launch the app's agent and request changes. The agent retains relevant conversation and app context, validates the update, protects existing data, and makes the new version available.

### 6. Share intentionally

The user can invite friends to use an app within Hyos. During the initial product phase, collaborators share the app's entire database rather than receiving granular permissions.

## Initial platform capabilities

- Conversational app creation and modification.
- A mobile-first personal home screen for created and shared apps.
- An opinionated, agent-friendly application runtime, likely based on SolidJS.
- Prebuilt, mobile-ready interface components.
- A hosted real-time database with optimistic updates.
- A curated integration layer backed by a connector platform such as Composio.
- Scheduled and event-driven workflows.
- Automated end-to-end validation before builds and updates are released.
- Database migration validation, automatic pre-update backups, and rollback.
- In-platform sharing with clear whole-database access disclosure.
- Persistent app and conversation context for future modification.

## Initial boundaries

Hyos is initially optimized for small personal apps, not arbitrary production software. The first version does not promise:

- Free-form choice of frameworks, databases, or infrastructure.
- Granular database authorization or record-level sharing controls.
- Independent App Store or Play Store distribution.
- Enterprise-grade multi-tenant applications.
- Safe collaboration where users must see different subsets of the same app data.
- Compatibility with every external API or arbitrary package.

Requests outside the platform's safety and reliability envelope should be narrowed, declined, or redirected rather than generated as fragile software.

## Product integrity requirements

An app is not ready merely because it renders. Before delivery, Hyos should establish that:

- Its primary user flows succeed end to end.
- Connected services and scheduled workflows behave as described.
- Data persists and synchronizes correctly across relevant views.
- Failure and empty states remain usable on a phone.
- An update does not silently destroy or invalidate existing data.
- A failed release can be reverted to a known-good app version and database backup.
- Sharing implications are understood before another person receives access.

## Key open decisions

The following choices should be resolved during product definition:

- Which app categories and behaviors will be explicitly unsupported at launch.
- How users review and approve access to third-party integrations.
- Whether shared users bring their own connector credentials or use the owner's connections.
- How much of the agent's build and test process is visible to the user.
- What guarantees an exported app receives and how it operates outside Hyos.
- How long app versions, database backups, and conversation history are retained.
- What happens when an integration fails after an app has already been delivered.
- Which signals define a successful first app: time to usable result, test pass rate, repeat use, or another measure.

## Product promise

Describe the personal tool you need. Hyos builds it, proves that it works, and keeps it ready wherever you use it.
