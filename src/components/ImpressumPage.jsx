import { LegalPageLayout, LegalPlaceholder } from './LegalPageLayout'

// Mandatory legal notice for a commercially/business-operated telemedia
// service reachable from Germany (§5 DDG — Digitale-Dienste-Gesetz, which
// replaced §5 TMG in May 2024). Every field marked with LegalPlaceholder is
// a legal requirement the OPERATOR must fill in with real, accurate
// information before this deployment goes live — a live Impressum with
// placeholder text is not compliant and is a common target for Abmahnungen
// (cease-and-desist warnings) in Germany. This file is not legal advice;
// have it reviewed by a lawyer, especially the register/VAT fields, which
// depend on your actual legal form (Einzelunternehmen, GbR, UG, GmbH, ...).
export function ImpressumPage() {
  return (
    <LegalPageLayout title="Impressum">
      <p>Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz):</p>

      <h2>Diensteanbieter</h2>
      <p>
        <LegalPlaceholder>[Vollständiger Name / Firma]</LegalPlaceholder><br />
        <LegalPlaceholder>[Straße und Hausnummer]</LegalPlaceholder><br />
        <LegalPlaceholder>[PLZ Ort]</LegalPlaceholder><br />
        <LegalPlaceholder>[Land]</LegalPlaceholder>
      </p>
      <p>
        Bei einer juristischen Person (z. B. GmbH, UG) zusätzlich: Rechtsform und
        vertretungsberechtigte Person(en) angeben (<LegalPlaceholder>[z. B. „vertreten durch Geschäftsführer:in ...&rdquo;]</LegalPlaceholder>).
      </p>

      <h2>Kontakt</h2>
      <p>
        Telefon: <LegalPlaceholder>[Telefonnummer]</LegalPlaceholder><br />
        E-Mail: <LegalPlaceholder>[E-Mail-Adresse]</LegalPlaceholder>
      </p>
      <p>
        Nach der Rechtsprechung des EuGH und BGH reicht eine reine E-Mail-Adresse
        allein unter Umständen nicht aus — es muss ein Weg zur schnellen
        elektronischen Kontaktaufnahme bestehen (z. B. Telefon oder
        Kontaktformular zusätzlich zur E-Mail).
      </p>

      <h2>Registereintrag</h2>
      <p>
        Falls im Handelsregister, Vereinsregister, Partnerschaftsregister oder
        Genossenschaftsregister eingetragen:
      </p>
      <p>
        Registergericht: <LegalPlaceholder>[Registergericht]</LegalPlaceholder><br />
        Registernummer: <LegalPlaceholder>[Registernummer]</LegalPlaceholder>
      </p>
      <p>
        Falls kein Registereintrag besteht (z. B. Kleingewerbe/Freiberufler),
        diesen Abschnitt entfernen.
      </p>

      <h2>Umsatzsteuer-ID</h2>
      <p>
        Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG:{' '}
        <LegalPlaceholder>[USt-IdNr. oder „Kein Ausweis gem. § 19 UStG (Kleinunternehmerregelung)&rdquo;]</LegalPlaceholder>
      </p>

      <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
      <p>
        <LegalPlaceholder>[Name, Anschrift wie oben]</LegalPlaceholder> — nur
        erforderlich, falls redaktionelle/journalistisch-redaktionelle Inhalte
        (z. B. ein Blog) angeboten werden; für ein reines SaaS-Dashboard ohne
        Blog kann dieser Abschnitt in der Regel entfallen.
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

      <h2>Verbraucherstreitbeilegung / Universalschlichtungsstelle</h2>
      <p>
        Wir sind <LegalPlaceholder>[nicht bereit / bereit]</LegalPlaceholder>, an
        Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
        teilzunehmen (§ 36 VSBG).
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
