import { LegalPageLayout } from './LegalPageLayout'

// Legal notice for a privately/non-commercially operated telemedia service
// reachable from Germany (§5 DDG — Digitale-Dienste-Gesetz, which replaced
// §5 TMG in May 2024), filled in for the natural-person operator of this
// instance — no Handelsregister entry, no VAT (private, non-commercial), and
// no §18 MStV editorial-responsible-person section (only applies to
// journalistic/editorial content like a blog, which this dashboard doesn't
// have). This file is not legal advice; a non-commercial private offering
// may not need an Impressum at all under §5 DDG's "geschäftsmäßig" test —
// this one is kept anyway as low-cost insurance since the instance is
// reachable by other logged-in users, not just the operator alone. Have it
// reviewed by a lawyer if that changes.
export function ImpressumPage() {
  return (
    <LegalPageLayout title="Impressum">
      <p>Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz):</p>

      <h2>Diensteanbieter</h2>
      <p>
        Eugen Chladny<br />
        Teckstr. 12<br />
        73240 Wendlingen<br />
        Deutschland
      </p>

      <h2>Kontakt</h2>
      <p>
        Telefon: +49 176 97343242<br />
        E-Mail: echladny@msn.com
      </p>

      <h2>Umsatzsteuer</h2>
      <p>
        Dieses Angebot wird privat und nicht gewerblich betrieben. Es erfolgt
        keine Umsatzsteuererhebung; eine Umsatzsteuer-Identifikationsnummer
        gemäß § 27a UStG besteht nicht.
      </p>

      <h2>EU-Streitschlichtung</h2>
      <p>
        Die Europäische Kommission stellt eine Plattform zur
        Online-Streitbeilegung (OS) bereit:{' '}
        <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noopener noreferrer">
          https://ec.europa.eu/consumers/odr/
        </a>
        . Unsere E-Mail-Adresse finden Sie oben.
      </p>

      <h2>Verbraucherstreitbeilegung</h2>
      <p>
        Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren
        vor einer Verbraucherschlichtungsstelle teilzunehmen (§ 36 VSBG).
      </p>

      <h2>Haftung für Inhalte und Links</h2>
      <p>
        Als Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für eigene Inhalte auf
        diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Für externe
        Links auf Inhalte Dritter übernehmen wir keine Gewähr; zum Zeitpunkt der
        Verlinkung waren keine Rechtsverstöße erkennbar. Eine permanente
        inhaltliche Kontrolle der verlinkten Seiten ist ohne konkrete Anhaltspunkte
        einer Rechtsverletzung nicht zumutbar.
      </p>
    </LegalPageLayout>
  )
}
