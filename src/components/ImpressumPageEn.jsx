import { LegalPageLayout } from './LegalPageLayout'

// English translation of ImpressumPage.jsx — convenience only. The German
// version at /impressum is the legally authoritative text; keep both in
// sync when editing either one.
export function ImpressumPageEn() {
  return (
    <LegalPageLayout title="Legal Notice">
      <p className="italic"><a href="/impressum">Deutsche Version</a></p>

      <p>
        Information pursuant to §5 DDG (Digitale-Dienste-Gesetz, Germany&apos;s
        Digital Services Act); the <a href="/impressum">German version</a> is
        the legally authoritative text:
      </p>

      <h2>Service provider</h2>
      <p>
        Eugen Chladny<br />
        Teckstr. 12<br />
        73240 Wendlingen<br />
        Germany
      </p>

      <h2>Contact</h2>
      <p>
        Phone: +49 176 97343242<br />
        Email: echladny@msn.com
      </p>

      <h2>VAT</h2>
      <p>
        This offering is operated privately and non-commercially. No VAT is
        charged; no VAT identification number pursuant to §27a UStG exists.
      </p>

      <h2>EU online dispute resolution</h2>
      <p>
        The European Commission provides a platform for online dispute
        resolution (ODR):{' '}
        <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noopener noreferrer">
          https://ec.europa.eu/consumers/odr/
        </a>
        . Our email address is provided above.
      </p>

      <h2>Consumer dispute resolution</h2>
      <p>
        We are neither willing nor obliged to participate in dispute
        resolution proceedings before a consumer arbitration board (§36 VSBG).
      </p>

      <h2>Liability for content and links</h2>
      <p>
        As a service provider, we are responsible for our own content on
        these pages in accordance with general law, pursuant to §7(1) DDG. We
        assume no liability for external links to third-party content; at the
        time of linking, no legal violations were apparent. Continuous
        monitoring of linked pages&apos; content is not reasonable without
        concrete evidence of a legal violation.
      </p>
    </LegalPageLayout>
  )
}
