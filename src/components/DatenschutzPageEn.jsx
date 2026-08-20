import { LegalPageLayout } from './LegalPageLayout'

// English translation of DatenschutzPage.jsx — convenience only. The German
// version at /datenschutz is the legally authoritative text; keep both in
// sync when editing either one, especially sections 4-6 (deployment-specific
// facts: self-hosted Nextcloud/Speckle, configured AI providers).
export function DatenschutzPageEn() {
  return (
    <LegalPageLayout title="Privacy Policy">
      <p className="italic"><a href="/datenschutz">Deutsche Version</a></p>

      <p>
        This English version is provided for convenience; the{' '}
        <a href="/datenschutz">German version</a> is the legally authoritative
        text.
      </p>

      <h2>1. Controller</h2>
      <p>
        The controller within the meaning of the General Data Protection
        Regulation (GDPR) is:
      </p>
      <p>
        Eugen Chladny<br />
        Teckstr. 12, 73240 Wendlingen, Germany<br />
        Email: echladny@msn.com
      </p>
      <p>
        (See <a href="/impressum-en">Legal Notice</a> for details.) No data
        protection officer has been appointed — under Art. 37 GDPR / §38 BDSG
        this only becomes mandatory above certain thresholds (generally 20 or
        more people continuously involved in the automated processing of
        personal data), which does not apply to a sole-proprietor operation.
      </p>

      <h2>2. Server log files</h2>
      <p>
        When you access this application, the server automatically collects
        technical connection data (IP address, date/time, requested URL,
        browser, referrer). The legal basis is Art. 6(1)(f) GDPR (legitimate
        interest in the operation, stability, and security of the
        application).
      </p>

      <h2>3. User account and login</h2>
      <p>
        Using this application requires a login. We process your name, email
        address, password (stored as a hash, not in plain text), and — if
        your organization uses multi-tenant/ISO 19650 features — your
        assignment to an organization within a project. The legal basis is
        Art. 6(1)(b) GDPR (performance of a contract or pre-contractual
        measures).
      </p>
      <p>
        Logging in sets a technically necessary session cookie that maintains
        your logged-in state. This cookie is strictly required for operation
        (Art. 6(1)(b), (f) GDPR) and falls under the exception in §25(2) TTDSG
        — it therefore does not require separate consent. No tracking or
        analytics cookies are set.
      </p>

      <h2>4. Project, model, and document data</h2>
      <p>
        The BIM models, documents, and drawings uploaded by you or your
        organization may contain personal data belonging to third parties
        (e.g. planners&apos; names in metadata or document content). We process
        this data on behalf of your organization. If this application is
        provided to multiple organizations/customers as SaaS, a data
        processing agreement (Art. 28 GDPR) must be concluded with each
        organization — this text does not replace such an agreement.
      </p>
      <p>
        Documents are stored in a Nextcloud instance. This runs self-hosted on
        the operator&apos;s own infrastructure — no third-party hosting is used
        for Nextcloud.
      </p>

      <h2>5. Speckle server (3D model data)</h2>
      <p>
        Model data is synchronized via a Speckle server. This application is
        configured to use a self-hosted Speckle server on the operator&apos;s own
        infrastructure — not the service hosted by Speckle Systems Inc.
        (app.speckle.systems). No data is therefore transmitted to Speckle
        Systems Inc. Should this instance be switched to app.speckle.systems
        in the future, that would constitute a transfer of data to a third
        country (USA) within the meaning of Art. 44 ff. GDPR, requiring
        appropriate safeguards (e.g. EU Standard Contractual Clauses).
      </p>

      <h2>6. AI assistant (optional)</h2>
      <p>
        This application offers an optional AI chat assistant. Depending on
        configuration, your chat inputs and relevant model/project excerpts
        are transmitted to one of the following providers: OpenAI (OpenAI,
        L.L.C., USA), Anthropic (Anthropic PBC, USA), Mistral AI (Mistral AI,
        France/EU) — or, if a local/self-hosted model (Ollama, LM Studio) is
        configured, the data never leaves your own infrastructure at all.
      </p>
      <p>
        Currently configured on this instance: Mistral AI (France/EU, the
        preset default provider), OpenAI (OpenAI, L.L.C., USA), and locally
        run models via Ollama and LM Studio (never leave your own
        infrastructure). Anthropic is not configured on this instance. You
        can choose the provider for your own session in the chat settings —
        the default is Mistral AI.
      </p>
      <p>
        Choosing OpenAI constitutes a transfer of data to a third country
        (USA, Art. 44 ff. GDPR); the operator relies on the safeguards OpenAI
        offers for this (e.g. EU Standard Contractual Clauses or the EU-US
        Data Privacy Framework, depending on their status at the time of use)
        and must conclude a data processing agreement (Art. 28 GDPR) with
        OpenAI. Mistral AI (an EU provider) and Ollama/LM Studio (local, no
        external transmission) do not involve a third-country transfer. The
        legal basis for use is Art. 6(1)(b) or (f) GDPR.
      </p>

      <h2>7. Email notifications</h2>
      <p>
        If the operator has configured an SMTP server, we send email
        notifications about document status changes and BCF assignments to
        your registered email address. The legal basis is Art. 6(1)(b), (f)
        GDPR. Without an SMTP configuration, notifications are delivered
        in-app only.
      </p>

      <h2>8. Recipients</h2>
      <p>
        Personal data is only shared with third parties within the scope of
        the processors mentioned above (hosting, Speckle where applicable, AI
        provider where applicable, email delivery service where applicable),
        as well as with members of the same organization within a project,
        to the extent necessary for collaboration (BCF topics, document
        approvals).
      </p>

      <h2>9. Retention period</h2>
      <p>
        Personal data is stored for as long as the user account exists or a
        legitimate interest in continued storage exists (e.g. evidence of
        completed approval workflows). After a project is deleted on the
        Speckle server, the corresponding locally mirrored model and document
        data is automatically removed.
      </p>

      <h2>10. Your rights</h2>
      <p>Under the GDPR, you have the right to:</p>
      <ul>
        <li>Access the personal data stored about you (Art. 15 GDPR)</li>
        <li>Rectification of inaccurate data (Art. 16 GDPR)</li>
        <li>Erasure (Art. 17 GDPR)</li>
        <li>Restriction of processing (Art. 18 GDPR)</li>
        <li>Data portability (Art. 20 GDPR)</li>
        <li>Object to processing (Art. 21 GDPR)</li>
        <li>Lodge a complaint with a data protection supervisory authority (Art. 77 GDPR)</li>
      </ul>
      <p>
        Competent supervisory authority: Der Landesbeauftragte für den
        Datenschutz und die Informationsfreiheit Baden-Württemberg (LfDI
        Baden-Württemberg), Königstraße 10a, 70173 Stuttgart, Germany.
      </p>

      <h2>11. No automated decision-making</h2>
      <p>
        No automated decision-making, including profiling, within the meaning
        of Art. 22 GDPR that produces legal effects concerning you takes
        place. Clash, IDS, and validation checks are purely technical model
        evaluations that do not assess people.
      </p>

      <h2>12. Changes to this privacy policy</h2>
      <p>
        We update this privacy policy whenever the services we use or the
        legal situation change. Last updated: 20 August 2026.
      </p>
    </LegalPageLayout>
  )
}
