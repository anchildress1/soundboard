# Challenge Rubric

Source: [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01) and the [announcement post](https://dev.to/devteam/join-the-hacktoberfest-weekend-challenge-build-for-a-friend-2450-in-prizes-across-17-winners-1aj5), read 2026-10-03.

- **Prompt:** build something with open-source AI at its core — an open-weight model, an open-source agent harness or framework, local inference, or all three.
- **Theme:** ship something that solves a real problem for one real friend.
- **Deadline:** 2026-10-05 06:59 UTC.
- **Tags:** `devchallenge`, `weekendchallenge`, `hf26challenge`.
- **Template H2s:** What I Built · Demo · Code · How I Built It · Why Does Open Innovation Matter? · My Agent Session (optional) · Prize Categories.
- **Categories entered:** Best Use of Gemma (featured, $200) · Best Use of Sentry Agent Tracing (partner, $100).

## Evidence table

Judging order, heaviest first. Every row needs a link, number, or image before the post ships.

| Criterion                             | What a judge can click or see                               | What this entry produces                                                                                |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Writing quality                       | The post                                                    | One story: Nathan's real video, one recommendation, one verified upload                                 |
| Relevance: open-source AI at the core | "Why open" section; architecture                            | Gemma 4 12B open weights on our own L4; no inference provider; Nathan's audio never leaves the project  |
| Relevance: built for a real friend    | What I Built; Nathan's quote                                | Nathan's real upload, his edit history, his reaction                                                    |
| Creativity                            | Demo; diff screenshot                                       | Current-vs-proposed diff on a live FLR video; hashtags picked from a deterministic search, not invented |
| Technical execution                   | Live `run.app` embed; GitHub repo                           | Working sample run on a phone; test and coverage numbers; CI green                                      |
| Use of partner tech: Gemma            | How I Built It                                              | Audio + frames per 29.5s window through Gemma's native audio input, served from Cloud Run               |
| Use of partner tech: Sentry           | Trace screenshots                                           | One trace per job with `invoke_agent` / `chat` spans and token counts; one failed-run trace             |
| Demo (required)                       | `{% embed https://<service>.run.app %}` + walkthrough video | 30-second FLR samples, one tap each                                                                     |
| Code (required)                       | `{% embed https://github.com/anchildress1/soundboard %}`    | MIT repo with README, PRD, tests                                                                        |
| My Agent Session (optional)           | DevRelay embed                                              | Decide by Sun 14:30 EDT                                                                                 |

## Gates

- [ ] The win (a verified upload of Nathan's video) is finished before the deadline.
- [ ] Every number and screenshot is public; nothing from Nathan's unreleased masters is shown without his OK.
- [ ] The title carries one concrete number or contradiction. Candidates: "It listens to every second and looks every four" · "My friend's unreleased masters never left my GPU".
