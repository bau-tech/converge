import { LegalPageLayout, LegalPlaceholder } from './LegalPageLayout'

// GDPR/DSGVO Art. 13-14 privacy notice. The prose below is written to match
// what this codebase actually does (session-cookie auth, self-hostable
// Nextcloud/Speckle, optional third-party AI providers configured via env
// vars — see .env.example) so it doesn't overclaim or underclaim. It still
// has operator-specific gaps (marked LegalPlaceholder) this file cannot fill
// in on its own: your contact details, your server's actual physical
// location/hosting provider, and — most importantly — WHICH of the optional
// integrations below are actually enabled on THIS deployment. Delete the
// paragraphs describing integrations you don't run. This is not legal
// advice; have a lawyer review this before going live, particularly the
// third-country AI-provider transfer section if you enable OpenAI/Anthropic.
export function DatenschutzPage() {
  return (
    <LegalPageLayout title="Datenschutzerklärung">
      <h2>1. Verantwortlicher</h2>
      <p>
        Verantwortlicher im Sinne der Datenschutz-Grundverordnung (DSGVO) ist:
      </p>
      <p>
        <LegalPlaceholder>[Vollständiger Name / Firma]</LegalPlaceholder><br />
        <LegalPlaceholder>[Straße, PLZ Ort, Land]</LegalPlaceholder><br />
        E-Mail: <LegalPlaceholder>[E-Mail-Adresse]</LegalPlaceholder>
      </p>
      <p>
        (Details siehe <a href="/impressum">Impressum</a>.) Ein:e
        Datenschutzbeauftragte:r ist{' '}
        <LegalPlaceholder>[nicht bestellt / erreichbar unter ...]</LegalPlaceholder>{' '}
        — nach Art. 37 DSGVO / § 38 BDSG erst ab bestimmten Schwellenwerten
        verpflichtend (i. d. R. ab 20 Personen, die ständig mit der
        automatisierten Verarbeitung personenbezogener Daten befasst sind).
      </p>

      <h2>2. Server-Logfiles</h2>
      <p>
        Beim Aufruf dieser Anwendung erhebt der Server automatisch technische
        Verbindungsdaten (IP-Adresse, Datum/Uhrzeit, aufgerufene URL, Browser,
        Referrer). Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes
        Interesse an Betrieb, Stabilität und Sicherheit der Anwendung).
      </p>

      <h2>3. Nutzerkonto und Anmeldung</h2>
      <p>
        Für die Nutzung ist ein Login erforderlich. Dabei verarbeiten wir Name,
        E-Mail-Adresse, Passwort (als Hash gespeichert, nicht im Klartext) sowie
        — falls Ihre Organisation Mehr-Mandanten-/ISO-19650-Funktionen nutzt —
        Ihre Zuordnung zu einer Organisation innerhalb eines Projekts.
        Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung bzw.
        vorvertragliche Maßnahmen).
      </p>
      <p>
        Die Anmeldung setzt ein technisch notwendiges Session-Cookie, das den
        eingeloggten Zustand hält. Dieses Cookie ist für den Betrieb zwingend
        erforderlich (Art. 6 Abs. 1 lit. b, f DSGVO) und fällt unter die
        Ausnahme des § 25 Abs. 2 TTDSG — es bedarf daher keiner gesonderten
        Einwilligung. Es werden keine Tracking- oder Analyse-Cookies gesetzt.
      </p>

      <h2>4. Projekt-, Modell- und Dokumentdaten</h2>
      <p>
        Die von Ihnen bzw. Ihrer Organisation hochgeladenen BIM-Modelle,
        Dokumente und Zeichnungen können personenbezogene Daten Dritter
        enthalten (z. B. Namen von Planer:innen in Metadaten oder
        Dokumentinhalten). Hier verarbeiten wir diese Daten im Auftrag Ihrer
        Organisation. Falls diese Anwendung mehreren Organisationen/Kunden als
        SaaS bereitgestellt wird, ist mit jeder Organisation ein
        Auftragsverarbeitungsvertrag (AVV, Art. 28 DSGVO) abzuschließen — dieser
        Text ersetzt keinen solchen Vertrag.
      </p>
      <p>
        Dokumente werden in einer Nextcloud-Instanz gespeichert. Diese läuft{' '}
        <LegalPlaceholder>[selbst gehostet auf eigener/gemieteter Infrastruktur bei ... / durch einen Drittanbieter betrieben]</LegalPlaceholder>.
        Wird ein Drittanbieter für Hosting genutzt, ist mit diesem ebenfalls ein
        AVV erforderlich.
      </p>

      <h2>5. Speckle-Server (3D-Modelldaten)</h2>
      <p>
        Modelldaten werden über einen Speckle-Server synchronisiert. Diese
        Anwendung ist konfiguriert für:{' '}
        <LegalPlaceholder>[einen selbst gehosteten Speckle-Server / app.speckle.systems (Speckle Systems Inc., USA)]</LegalPlaceholder>.
        Wird der von Speckle Systems Inc. gehostete Dienst genutzt, handelt es
        sich um eine Datenübermittlung in ein Drittland (USA) im Sinne von Art.
        44 ff. DSGVO; Speckle Systems Inc. muss dafür geeignete Garantien
        bieten (z. B. EU-Standardvertragsklauseln). Details siehe die
        Datenschutzerklärung von Speckle Systems.
      </p>

      <h2>6. KI-Assistent (optional)</h2>
      <p>
        Diese Anwendung bietet einen optionalen KI-Chat-Assistenten. Je nach
        Konfiguration werden dabei Ihre Chat-Eingaben und relevante
        Modell-/Projektausschnitte an einen der folgenden Anbieter
        übermittelt: OpenAI (OpenAI, L.L.C., USA), Anthropic (Anthropic PBC,
        USA), Mistral AI (Mistral AI, Frankreich/EU) — oder, wenn ein
        lokal/selbst gehostetes Modell (Ollama, LM Studio) konfiguriert ist,
        verlassen die Daten die eigene Infrastruktur überhaupt nicht.
      </p>
      <p>
        Auf dieser Instanz ist aktuell konfiguriert:{' '}
        <LegalPlaceholder>[aktiven Anbieter eintragen, z. B. „Mistral AI (EU)&rdquo; oder „lokal via Ollama, keine Datenübermittlung&rdquo;]</LegalPlaceholder>.
        Bei Nutzung von OpenAI oder Anthropic handelt es sich um eine
        Datenübermittlung in ein Drittland (USA, Art. 44 ff. DSGVO); prüfen Sie
        vor Live-Betrieb, ob der jeweilige Anbieter zum Zeitpunkt der Nutzung
        unter das EU-US Data Privacy Framework fällt oder auf
        EU-Standardvertragsklauseln gestützt werden muss, und schließen Sie den
        entsprechenden AVV mit dem Anbieter ab. Rechtsgrundlage der Nutzung ist
        Art. 6 Abs. 1 lit. b bzw. f DSGVO.
      </p>

      <h2>7. Benachrichtigungen per E-Mail</h2>
      <p>
        Sofern der Betreiber einen SMTP-Server konfiguriert hat, versenden wir
        E-Mail-Benachrichtigungen zu Dokumentstatus-Änderungen und
        BCF-Zuweisungen an Ihre hinterlegte E-Mail-Adresse. Rechtsgrundlage ist
        Art. 6 Abs. 1 lit. b, f DSGVO. Ohne SMTP-Konfiguration erfolgen
        Benachrichtigungen ausschließlich In-App.
      </p>

      <h2>8. Empfänger</h2>
      <p>
        Eine Weitergabe personenbezogener Daten an Dritte erfolgt nur im Rahmen
        der oben genannten Auftragsverarbeiter (Hosting, ggf. Speckle
        Systems, ggf. KI-Anbieter, ggf. E-Mail-Versanddienst) sowie an
        Mitglieder derselben Organisation innerhalb eines Projekts, soweit dies
        für die Zusammenarbeit (BCF-Themen, Dokumentenfreigaben) erforderlich
        ist.
      </p>

      <h2>9. Speicherdauer</h2>
      <p>
        Personenbezogene Daten werden gespeichert, solange das Nutzerkonto
        besteht bzw. ein berechtigtes Interesse an der weiteren Speicherung
        besteht (z. B. Nachweis abgeschlossener Freigabe-Workflows). Nach
        Löschung eines Projekts auf dem Speckle-Server werden zugehörige lokal
        gespiegelte Modell- und Dokumentdaten automatisiert entfernt.
      </p>

      <h2>10. Ihre Rechte</h2>
      <p>Sie haben nach der DSGVO das Recht auf:</p>
      <ul>
        <li>Auskunft über die zu Ihrer Person gespeicherten Daten (Art. 15 DSGVO)</li>
        <li>Berichtigung unrichtiger Daten (Art. 16 DSGVO)</li>
        <li>Löschung (Art. 17 DSGVO)</li>
        <li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
        <li>Datenübertragbarkeit (Art. 20 DSGVO)</li>
        <li>Widerspruch gegen die Verarbeitung (Art. 21 DSGVO)</li>
        <li>Beschwerde bei einer Datenschutzaufsichtsbehörde (Art. 77 DSGVO)</li>
      </ul>
      <p>
        Zuständige Aufsichtsbehörde: <LegalPlaceholder>[zuständige Landesdatenschutzbehörde je nach Bundesland des Verantwortlichen]</LegalPlaceholder>.
      </p>

      <h2>11. Keine automatisierte Entscheidungsfindung</h2>
      <p>
        Eine automatisierte Entscheidungsfindung einschließlich Profiling im
        Sinne von Art. 22 DSGVO mit rechtlicher Wirkung für Sie findet nicht
        statt. Clash-, IDS- und Validierungsprüfungen sind rein technische
        Modellauswertungen ohne Bewertung von Personen.
      </p>

      <h2>12. Änderungen dieser Datenschutzerklärung</h2>
      <p>
        Wir passen diese Datenschutzerklärung an, sobald sich die
        eingesetzten Dienste oder die Rechtslage ändern. Stand:{' '}
        <LegalPlaceholder>[Datum der letzten Änderung]</LegalPlaceholder>.
      </p>
    </LegalPageLayout>
  )
}
