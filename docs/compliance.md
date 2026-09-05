# Compliance constraints — a code review checklist

From spec §6. These follow from the Wet DBA position: no *gezag*, the
freelancer determines their own working method and hours.

They are **structural, not stylistic**. A later "small usability improvement"
that reintroduces any of them is a compliance regression, which is why they
live in code review and not only in a document.

This file is not legal advice and does not replace the terms document. It is
the engineering translation of a position that has already been taken.

---

## The checklist

Ask these of any pull request that touches a timesheet, an assignment screen,
or the data model.

- [ ] **No start time, end time, break or clock in/out field.** Hours per day
      only. A field that records *when* someone worked is a field that records
      that someone was told when to work.
- [ ] **No client-visible or client-editable schedule, roster, or
      expected-hours field.** The client sees what was worked, after the fact.
- [ ] **No client-side action that assigns, sequences or approves *work*.**
      The approver approves *hours as an invoicing basis*. Not tasks, not
      output, not performance.
- [ ] **No presence, location or activity indicators.** No "last seen", no
      "currently working on", no geolocation on an entry.
- [ ] **No employee-lookalike surfaces.** No company announcements, no org
      chart, no perks, no internal comms, no onboarding checklist.
- [ ] **Outreach consent stays opt-in.** Direct outreach based on profile data
      requires consent captured at signup. Not in v1 scope; the field exists on
      the user model now so it is never bolted on later.

## Where this is enforced in code

| Constraint | Enforced by |
|---|---|
| Allowed timesheet fields | `ALLOWED_TIME_ENTRY_FIELDS` in `src/domain/model.js` |
| Refusal of forbidden fields | `assertNoForbiddenFields()`, called on every draft save |
| The forbidden list itself | `FORBIDDEN_TIME_ENTRY_FIELDS` in `src/domain/model.js` |
| Tests | `src/test/tests.js` → "Compliance — spec section 6, the absences" |
| Database | `time_entries` in `src/data/supabase/schema.sql` has four columns |
| Consent field | `app_users.outreach_consent`, default `false` |

The test iterates the forbidden list and asserts each one is refused, so
extending the list extends the test automatically. Adding a column to
`time_entries` fails the suite before it reaches review.

## Things that look like features and are not

Requests in this shape will arrive. They are all the same request.

> *"Can the client see how many hours are expected this month?"*
> No. That is a schedule.

> *"Can we add a note field so the freelancer explains a long day?"*
> A free-text activity description is an activity log. If a day needs
> explaining, that is what the rejection comment and a phone call are for.

> *"Can the approver tick off individual days instead of the whole month?"*
> No — spec §4/C1 is explicit: approve all or reject with a reason. Per-day
> approval is approval of work, one day at a time.

> *"Can we show start and end times, just for the freelancer's own reference?"*
> A field that exists is a field that gets exported, subpoenaed, and pointed at.
> If the freelancer wants a personal record, they have one.

> *"Can we add a reminder that hours are due by the 3rd?"*
> A reminder about an invoicing deadline is fine. A reminder about *working
> hours* is not. Spec §5 has seven emails; adding an eighth requires removing
> one.

## The one deliberate deviation in this build

The audit trail is rendered at the bottom of C2 (assignment detail) as a
collapsed section, rather than living only in an ops admin panel as spec §2
intends.

Reason: this build has no admin panel, and an append-only log that nobody can
read is a log nobody can check. It moves to the Supabase table editor when that
exists. Removing the `<details class="audit">` block in
`src/ui/screens/assignmentDetail.js` removes it cleanly.

It shows state changes only — who submitted, who approved, when. It shows no
activity, no times of day beyond timestamps of decisions, and nothing about how
the work was done.
