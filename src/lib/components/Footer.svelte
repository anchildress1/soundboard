<script lang="ts">
  import { resolve } from '$app/paths';
  import { faDev, faGithub, faLinkedin, faXTwitter } from '@fortawesome/free-brands-svg-icons';
  import { faGlobe } from '@fortawesome/free-solid-svg-icons';

  const SOCIAL = [
    { name: 'Site', href: 'https://anchildress1.dev', icon: faGlobe },
    { name: 'GitHub', href: 'https://github.com/anchildress1', icon: faGithub },
    { name: 'DEV', href: 'https://dev.to/anchildress1', icon: faDev },
    { name: 'LinkedIn', href: 'https://www.linkedin.com/in/anchildress1', icon: faLinkedin },
    { name: 'X', href: 'https://x.com/anchildress1', icon: faXTwitter },
  ];
</script>

<footer>
  <p>
    Built for
    <a
      href="https://flieslikerobots.bandcamp.com"
      target="_blank"
      rel="external noopener noreferrer">Flies Like Robots</a
    >
    by Ashley Childress · PolyForm Noncommercial 1.0.0
  </p>
  <div class="links">
    <nav class="social" aria-label="Ashley Childress">
      {#each SOCIAL as { name, href, icon: { icon: [width, height, , , path] } } (name)}
        <a {href} target="_blank" rel="external noopener noreferrer" aria-label={name} title={name}>
          <svg viewBox="0 0 {width} {height}" aria-hidden="true" focusable="false">
            <path d={[path].flat().join(' ')} />
          </svg>
        </a>
      {/each}
    </nav>
    <nav class="legal" aria-label="Legal">
      <a href={resolve('terms')} data-sveltekit-reload>Terms of Service</a>
      <a href={resolve('privacy')} data-sveltekit-reload>Privacy policy</a>
    </nav>
  </div>
</footer>

<style>
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 24px;
    padding: 16px var(--gutter);
    border-top: 1px solid var(--line);
    font-size: 13px;
    color: var(--muted);
  }

  .links,
  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
  }

  .legal a + a::before {
    margin: 0 10px;
    content: '•' / '';
    color: var(--line-strong);
  }

  /* Narrow screens wrap the two groups, where a divider would dangle. */
  @media (width >= 480px) {
    .links nav + nav::before {
      width: 1px;
      height: 1em;
      margin-right: 18px;
      content: '';
      background: var(--line-strong);
    }
  }

  /* Each icon keeps a 44px touch target; the margin lines the first icon up with the text edge. */
  .social {
    margin-left: -13px;
    margin-right: 5px;
  }

  .social a {
    justify-content: center;
    min-width: 44px;
  }

  svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }

  a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--muted);
    text-decoration: none;
  }

  a:hover {
    color: var(--ink);
  }

  .legal a:hover {
    text-decoration: underline;
  }

  p {
    margin: 0;
  }

  p a {
    min-height: 0;
    color: var(--ink);
  }
</style>
