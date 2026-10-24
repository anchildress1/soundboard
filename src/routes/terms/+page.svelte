<script lang="ts">
  import { resolve } from '$app/paths';
</script>

<svelte:head>
  <title>Terms of Service · Soundboard</title>
</svelte:head>

<main aria-labelledby="terms-title">
  <h1 id="terms-title">Terms of Service</h1>
  <p class="help">Effective October 24, 2026</p>

  <p>
    Ashley Childress operates Soundboard, a free, private music-release assistant. These terms apply
    to your use of the service. By using Soundboard, you agree to these terms.
  </p>

  <h2>Access and account</h2>
  <p>
    Access is currently by invitation through your Google account. Use only an account and YouTube
    channel you are authorized to control. Do not share access, bypass restrictions, or use
    Soundboard to violate anyone's rights or platform rules.
  </p>

  <h2>Your content</h2>
  <p>
    You retain your rights to the music, videos, artwork, and other material you provide. You must
    have the rights and permissions needed to process and upload that material. You give Soundboard
    permission to store and analyze it, prepare metadata and Shorts, and send approved uploads to
    your connected channel solely to provide the service. These terms do not transfer ownership of
    your content to Ashley.
  </p>

  <h2>Review and uploads</h2>
  <p>
    You are responsible for reviewing generated text, tags, clips, credits, and the destination
    channel before approving an upload. Each video and Short requires your approval. Uploads are
    private; you control publication on YouTube. Discarding a job does not delete a video already
    accepted by YouTube.
  </p>

  <h2>YouTube and privacy</h2>
  <p>
    Soundboard uses YouTube API Services. By using Soundboard, you also agree to be bound by the
    <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>. The
    <a href={resolve('/privacy')} data-sveltekit-reload>Privacy policy</a> explains the data we process,
    service providers, retention, deletion requests, and how to disconnect YouTube or revoke access through
    Google account permissions.
  </p>

  <h2>Alpha limitations</h2>
  <p>
    Soundboard is an early alpha provided as available, without a promise of uninterrupted service,
    accurate AI output, successful uploads, audience reach, or fanbase growth. Keep your original
    files and review every recommendation. Uploaded media is scheduled for deletion after seven
    days; Soundboard is not a backup service. Nothing in these terms limits rights or liabilities
    that cannot legally be limited.
  </p>

  <h2>Ending access and changes</h2>
  <p>
    You may stop using Soundboard at any time and disconnect YouTube on the Connections page. Ashley
    may suspend access for misuse or stop providing the alpha. Disconnecting does not delete saved
    data; request deletion as described in the Privacy policy. Changes to these terms will be posted
    here with an updated effective date and apply to future use.
  </p>

  <h2>Contact</h2>
  <p>
    Questions about these terms or access to Soundboard:
    <a href="mailto:anchildress1@gmail.com">anchildress1@gmail.com</a>.
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

  a {
    overflow-wrap: anywhere;
  }
</style>
