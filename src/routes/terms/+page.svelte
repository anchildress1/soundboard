<script lang="ts">
  import { resolve } from '$app/paths';
</script>

<svelte:head>
  <title>Terms of Service · Soundboard</title>
</svelte:head>

<main aria-labelledby="terms-title">
  <h2 id="terms-title">Terms of Service</h2>
  <p class="updated">Effective October 24, 2026</p>

  <p>
    Ashley Childress operates Soundboard, a free, private music-release assistant. These terms apply
    to your use of the service. By using Soundboard, you agree to these terms.
  </p>

  <h3>Access and account</h3>
  <p>
    Access is currently by invitation through your Google account. Use only an account and YouTube
    channel you are authorized to control. Do not share access, bypass restrictions, or use
    Soundboard to violate anyone's rights or platform rules.
  </p>

  <h3>Your content</h3>
  <p>
    You retain your rights to the music, videos, artwork, and other material you provide. You must
    have the rights and permissions needed to process and upload that material. You give Soundboard
    permission to store and analyze it, prepare metadata and Shorts, and send approved uploads to
    your connected channel solely to provide the service. These terms do not transfer ownership of
    your content to Ashley.
  </p>

  <h3>Review and uploads</h3>
  <p>
    You are responsible for reviewing generated text, tags, clips, credits, and the destination
    channel before approving an upload. Each video and Short requires your approval. Uploads are
    private; you control publication on YouTube. Discarding a job does not delete a video already
    accepted by YouTube.
  </p>

  <h3>YouTube and privacy</h3>
  <p>
    Soundboard uses YouTube API Services. By using Soundboard, you also agree to be bound by the
    <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>. The
    <a href={resolve('/privacy')} data-sveltekit-reload>Privacy policy</a> explains the data we process,
    service providers, retention, deletion requests, and how to disconnect YouTube or revoke access through
    Google account permissions.
  </p>

  <h3>Alpha limitations</h3>
  <p>
    Soundboard is an early alpha provided as available, without a promise of uninterrupted service,
    accurate AI output, successful uploads, audience reach, or fanbase growth. Keep your original
    files and review every recommendation. Uploaded media is scheduled for deletion after seven
    days; Soundboard is not a backup service. Nothing in these terms limits rights or liabilities
    that cannot legally be limited.
  </p>

  <h3>Ending access and changes</h3>
  <p>
    You may stop using Soundboard at any time and disconnect YouTube on the Connections page. Ashley
    may suspend access for misuse or stop providing the alpha. Disconnecting does not delete saved
    data; request deletion as described in the Privacy policy. Changes to these terms will be posted
    here with an updated effective date and apply to future use.
  </p>

  <h3>Contact</h3>
  <p>
    Questions about these terms or access to Soundboard:
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>.
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

  a {
    overflow-wrap: anywhere;
  }
</style>
