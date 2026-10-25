<svelte:head>
  <title>Privacy policy · Soundboard</title>
</svelte:head>

<main aria-labelledby="privacy-title">
  <h1 id="privacy-title">Privacy policy</h1>
  <p class="help">Updated October 25, 2026</p>

  <p>
    Ashley Childress operates Soundboard, a private music-release assistant. This policy covers
    information processed when you visit, sign in, prepare a release, or connect YouTube.
  </p>

  <h2>Information we use</h2>
  <ul>
    <li>Your Google account ID and email address identify your account and control access.</li>
    <li>
      Soundboard uses YouTube API Services to read channel details and video metadata, find genre
      examples and similar artists, and upload and verify videos you approve. It stores your channel
      connection and an encrypted refresh token so you can continue without signing in for every
      request.
    </li>
    <li>
      Uploaded media, song titles, notes, analysis, generated drafts, edits, approvals, and upload
      results support your releases. Each account stores an artist name and an optional Bandcamp URL
      and contact line, used for drafts and display. Artist memory linked to your profile stores
      feedback. Your profile also stores the voice and brand guide you approve, and any pending
      proposal with the uploads it read, which is deleted within 30 days or when you disconnect
      YouTube. Recent uploads read to identify your artist aren't stored.
    </li>
    <li>
      Before each draft, Soundboard researches public YouTube channels and videos of similar artists
      in your genre and size range, including their titles, descriptions, tags, and public view,
      like, comment, and subscriber counts as YouTube reports them. It keeps this research with the
      draft for up to 29 days and uses each artist as an individual example. Nothing is added up
      across channels, and any calculated number is labeled as calculated.
    </li>
    <li>
      If you choose <em>Share analytics</em> on the Connections page, Soundboard also reads YouTube Analytics
      results for your own public uploads: views and subscribers gained and lost in the first 28 days,
      and the title, description, and tags now on YouTube. It uses them to shape later drafts and keeps
      them for up to 29 days, refreshing them while you share. You can use Soundboard without sharing.
    </li>
  </ul>

  <h2>Processing and service providers</h2>
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
    image, and video payloads are replaced with placeholders in traces, as are the values that came
    from the YouTube API, such as other artists' names and statistics. URL query strings are
    scrubbed to remove credentials. Sentry keeps error reports and traces for 30 days. Soundboard
    does not sell your information or use it for advertising.
  </p>

  <h2>Cookies</h2>
  <p>
    A signed session cookie keeps you signed in for up to 30 days. A temporary authorization cookie
    protects Google sign-in and expires after 10 minutes. Soundboard does not use advertising
    cookies.
  </p>

  <h2>Storage and deletion</h2>
  <p>
    Uploaded media is scheduled for deletion by the storage bucket's seven-day lifecycle rule. Saved
    account records, analysis, drafts, and artist guidance are retained as needed to operate your
    account and prepare releases; media expiry does not delete those records. Genre-search evidence,
    similar-artist research, your analytics results, and the similar artists you mark "Not a peer"
    are hidden from the app after 29 days, and daily database cleanup deletes them. Existing drafts
    keep their selected tags and hashtags, rather than the expired research pool, and show that a
    cited artist's evidence has expired.
  </p>
  <p>
    To request deletion of your stored data, email
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>
    from your account email address. Ashley handles requests manually and deletes the relevant data as
    soon as possible, within seven calendar days. Deleting Soundboard data does not delete videos or other
    information held by YouTube. It also cannot reach the copies Google keeps for abuse monitoring or
    caching, or the traces Sentry holds; those expire on the schedules above.
  </p>

  <h2>YouTube access and your choices</h2>
  <p>
    Disconnect on the Connections page removes the stored connection token and asks Google to revoke
    Soundboard's grant. It deletes voice and brand proposals you haven't approved and the analytics
    results you shared; it does not delete saved jobs or your approved voice and brand guide.
    Disconnecting is also how you stop sharing analytics. If Google does not confirm revocation, the
    page asks you to finish revoking access in Google account permissions. You can also revoke
    access directly in
    <a href="https://security.google.com/settings/security/permissions"
      >Google account permissions</a
    >. Contact Ashley to request deletion of saved data after disconnecting.
  </p>
  <p>
    Google's handling of information is described in the
    <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. Your use of YouTube is
    subject to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.
  </p>

  <h2>Contact and changes</h2>
  <p>
    For privacy questions, complaints, or deletion requests, contact Ashley Childress at
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>. Changes to this policy will
    be published here with an updated date.
  </p>
</main>

<style>
  main {
    width: 100%;
    max-width: var(--measure-step);
    margin: 0 auto;
    padding: 40px var(--gutter) 64px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  h2 {
    margin-top: 20px;
  }

  ul {
    margin: 0;
    padding-left: 20px;
  }

  li + li {
    margin-top: 12px;
  }

  a {
    overflow-wrap: anywhere;
  }
</style>
