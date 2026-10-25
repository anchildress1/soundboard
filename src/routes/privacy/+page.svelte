<svelte:head>
  <title>Privacy policy · Soundboard</title>
</svelte:head>

<main aria-labelledby="privacy-title">
  <h2 id="privacy-title">Privacy policy</h2>
  <p class="updated">Updated October 24, 2026</p>

  <p>
    Ashley Childress operates Soundboard, a private music-release assistant. This policy covers
    information processed when you visit, sign in, prepare a release, or connect YouTube.
  </p>

  <h3>Information we use</h3>
  <ul>
    <li>Your Google account ID and email address identify your account and control access.</li>
    <li>
      Soundboard uses YouTube API Services to read channel details and video metadata, find genre
      examples, and upload and verify videos you approve. It stores your channel connection and an
      encrypted refresh token so you can continue without signing in for every request.
    </li>
    <li>
      Uploaded media, song titles, notes, analysis, generated drafts, edits, approvals, and upload
      results support your releases. Linked artist profiles also store identity, feedback, and brand
      guidance for later drafts.
    </li>
  </ul>

  <h3>Processing and service providers</h3>
  <p>
    Google Cloud hosts the app, uploaded media, and encryption keys. Neon stores account,
    connection, job, and artist-profile records. Google receives account authorization requests and
    the videos and metadata you approve for YouTube upload.
  </p>
  <p>
    The paid tier of Google's Gemini API analyzes media and writes drafts. It receives short clips
    of your uploaded video with their audio, your song details and notes, and YouTube metadata such
    as video titles, descriptions, tags, and thumbnails. On the paid tier, Google does not use this
    content to improve its products.
  </p>
  <ul>
    <li>
      Soundboard asks Gemini not to store each request and response for later use. That setting
      turns off stored interaction history only.
    </li>
    <li>
      Gemini may cache parts of a request automatically to answer similar requests faster. Google
      does not publish how long those cached copies last.
    </li>
    <li>
      Google keeps requests and responses for up to 55 days to detect abuse, and its policy terms
      allow that copy to be used to enforce those policies. Authorized Google staff may review
      flagged requests.
    </li>
  </ul>
  <p>
    Sentry receives error reports and performance traces, including text prompts, generated
    responses, and model reasoning that may contain song titles, notes, or release details. Audio,
    image, and video payloads are replaced with placeholders in traces, and URL query strings are
    scrubbed to remove credentials. Sentry keeps error reports and traces for 30 days. Soundboard
    does not sell your information or use it for advertising.
  </p>

  <h3>Cookies</h3>
  <p>
    A signed session cookie keeps you signed in for up to 30 days. A temporary authorization cookie
    protects Google sign-in and expires after 10 minutes. Soundboard does not use advertising
    cookies.
  </p>

  <h3>Storage and deletion</h3>
  <p>
    Uploaded media is scheduled for deletion by the storage bucket's seven-day lifecycle rule. Saved
    account records, analysis, drafts, and artist guidance are retained as needed to operate your
    account and prepare releases; media expiry does not delete those records. Genre-search evidence
    is excluded from app reads after 30 days, and daily database cleanup deletes expired evidence.
    Existing drafts keep their selected tags and hashtags, rather than the expired research pool.
  </p>
  <p>
    To request deletion of your stored data, email
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>
    from your account email address. Ashley handles requests manually and deletes the relevant data as
    soon as possible, within seven calendar days. Deleting Soundboard data does not delete videos or other
    information held by YouTube. It also cannot reach the copies Google keeps for abuse monitoring or
    caching, or the traces Sentry holds; those expire on the schedules above.
  </p>

  <h3>YouTube access and your choices</h3>
  <p>
    Disconnect on the Connections page removes the stored connection token and asks Google to revoke
    Soundboard's grant; it does not delete saved jobs or artist guidance. If Google does not confirm
    revocation, the page asks you to finish revoking access in Google account permissions. You can
    also revoke access directly in
    <a href="https://security.google.com/settings/security/permissions"
      >Google account permissions</a
    >. Contact Ashley to request deletion of saved data after disconnecting.
  </p>
  <p>
    Google's handling of information is described in the
    <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. Your use of YouTube is
    subject to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.
  </p>

  <h3>Contact and changes</h3>
  <p>
    For privacy questions, complaints, or deletion requests, contact Ashley Childress at
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>. Changes to this policy will
    be published here with an updated date.
  </p>
</main>

<style>
  main {
    max-width: 72ch;
    margin-inline: auto;
  }

  h2 {
    font: 700 28px/1.2 var(--display);
  }

  h3 {
    margin-top: 28px;
    font: 700 18px/1.4 var(--display);
  }

  .updated {
    color: var(--muted);
  }

  li + li {
    margin-top: 12px;
  }

  a {
    overflow-wrap: anywhere;
  }
</style>
