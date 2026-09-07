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
| Profile visibility | `assertProfileVisibleTo()`, and `read_profiles` in `002-marketplace.sql` |
| Scope never reaching an assignment | `buildAssignmentFromHire()`, and `trg_assignment_no_scope` |

The test iterates the forbidden list and asserts each one is refused, so
extending the list extends the test automatically. Adding a column to
`time_entries` fails the suite before it reaches review.

## The marketplace, and what it changed

Spec §1 excluded matching, search and freelancer profiles. That was reversed
deliberately. Two obligations came back with it, and both are enforced in code
rather than trusted to reviewers.

### Structured profiles are not a candidate database

§6: *"Direct outreach based on profile data requires opt-in captured at
signup."* So:

- There is **no company-facing profile search anywhere in this build.**
- A company can read a freelancer's profile only through an application that
  freelancer chose to send them.
- The one exception is `outreach_consent`, which is **off by default** and is
  the freelancer's to turn on. The profile screen says exactly what it does.

| Enforced by | Where |
|---|---|
| The visibility rule | `assertProfileVisibleTo()` in `src/domain/marketplace.js` |
| Called on the read path | `listApplicationsForProject()`, per row |
| Database | `read_profiles` policy in `002-marketplace.sql` |
| Tests | "Compliance §6 — profiles do not become a candidate database" |

If a profile search is ever built, `assertProfileVisibleTo` is where it must
be filtered, and the policy above is what will refuse it if the code forgets.

### Indicative scope on a posting

A project posting carries `indicative_hours_per_week`. This is the one place
this codebase records a number of hours that nobody worked, so it is worth
being precise about why it is allowed.

On a **pitch** it is commercial scoping: ordinary in Dutch freelance
contracting, and nobody can decide whether to apply without knowing whether an
engagement is one day a week or four. On a **live assignment** the same number
would be an expected-hours field, which §6 forbids.

So it is fenced three ways:

1. It is **never copied onto an Assignment.** `buildAssignmentFromHire()` omits
   it, and a test asserts the absence on the object the hire path produces.
2. **Nothing validates submitted hours against it.** A freelancer who bills 12
   hours in a week scoped at 32 gets no warning, because it is not a target.
3. The database **refuses** an assignment carrying it, via
   `trg_assignment_no_scope`, which checks the row as JSON rather than named
   columns — so it keeps working if someone adds the column without reading
   this file.

It is labelled "indicative scope" in both languages, with a line under it
saying it is not a roster and the freelancer decides how they arrange their
hours.

### Consent is captured at sign-up, as §6 says

§6: *"Direct outreach based on profile data requires opt-in captured at
signup."* The freelancer sign-up form now carries that checkbox, unticked, with
the same wording as the profile screen. Only a real boolean `true` counts —
`normaliseFreelancerSignup` and the SQL trigger both refuse a string `"true"`,
which is what a sloppy form serialisation produces and what would quietly opt
everyone in.

### A CV is personal data, and now you hold it

Uploading CVs means holding people's employment history, contact details and
sometimes more than that. In this build only the filename is stored and the
text never leaves the browser, so the exposure is small. That changes the day
the file goes into Supabase Storage.

Before that day, three things need an answer, and §10 has none of them:

- **Retention.** How long is a CV kept after an application is decided, or
  after an account goes quiet? "Forever" is a decision, not a default.
- **Deletion.** A freelancer asking to be deleted must take the CV with them,
  including copies attached to applications a company has already read.
- **Access.** Right now a company sees a profile through an application. If the
  CV file becomes downloadable, decide whether it is downloadable forever, or
  only while the application is live.

Adjacent to §10's open item on receipt retention, and worth deciding together.

### Postings must not read like job adverts

The description field's help text asks for **the work and the outcome, not the
working hours**. This is the most likely route by which gezag gets
reintroduced: a company writing "you will work Monday to Thursday, 9 to 5,
reporting to the site manager" has described employment, whatever the contract
says.

There is no moderation in this build. If postings start reading that way, that
is a product problem and a real one — not a copy problem.

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
