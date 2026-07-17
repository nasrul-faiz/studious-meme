const baileys = require('atexovi-baileys');

const { generateWAMessageFromContent, proto } = baileys;

function isPersonalJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function parseButtonParams(button) {
  if (!button || typeof button !== 'object') return {};

  if (typeof button.buttonParamsJson === 'string') {
    try {
      const parsed = JSON.parse(button.buttonParamsJson);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  if (typeof button.buttonParamsJson === 'object' && button.buttonParamsJson) {
    return button.buttonParamsJson;
  }

  return {};
}

function normalizeSingleSelectSections(rawSections, fallbackTitle) {
  const sections = Array.isArray(rawSections) ? rawSections : [];
  const cleanedSections = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;

    const rows = Array.isArray(section.rows) ? section.rows : [];
    const cleanedRows = rows
      .map((row) => {
        if (!row || typeof row !== 'object') return null;

        const id = String(row.id || '').trim();
        const title = String(row.title || row.display_text || '').trim();
        const header = String(row.header || '').trim();
        const description = String(row.description || '').trim();
        if (!id || !title) return null;

        const cleanedRow = { id, title };
        if (header) cleanedRow.header = header;
        if (description) cleanedRow.description = description;
        return cleanedRow;
      })
      .filter(Boolean);

    if (!cleanedRows.length) continue;

    const sectionTitle = String(section.title || section.section_title || 'Options').trim() || 'Options';
    const highlightLabel = String(section.highlight_label || '').trim();

    const cleanedSection = {
      title: sectionTitle,
      rows: cleanedRows,
    };
    if (highlightLabel) {
      cleanedSection.highlight_label = highlightLabel;
    }

    cleanedSections.push(cleanedSection);
  }

  if (cleanedSections.length) return cleanedSections;

  const fallbackId = String(fallbackTitle || '').trim();
  if (!fallbackId) return [];

  return [
    {
      title: 'Options',
      rows: [{ id: fallbackId, title: fallbackId }],
    },
  ];
}

function normalizeButton(button) {
  if (!button || typeof button !== 'object' || !button.name || !button.buttonParamsJson) return null;

  const name = String(button.name || '').trim();
  const params = parseButtonParams(button);

  const displayText = String(params.display_text || '').trim();

  // `cta_wa` is transformed to `cta_url` so the button reliably opens a WA chat.
  // This keeps behavior consistent even when interactive native payload falls back.
  if (name === 'cta_wa') {
    const phoneNumber = normalizePhone(params.phone_number || params.id || '');
    if (!phoneNumber) return null;

    const presetText = String(params.text || params.message || '').trim();
    const waUrl = presetText
      ? `https://wa.me/${phoneNumber}?text=${encodeURIComponent(presetText)}`
      : `https://wa.me/${phoneNumber}`;

    return {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: displayText || 'WhatsApp',
        url: waUrl,
        merchant_url: waUrl,
      }),
    };
  }

  if (name === 'cta_url') {
    const url = String(params.url || '').trim();
    if (!url) return null;

    return {
      name,
      buttonParamsJson: JSON.stringify({
        ...params,
        display_text: displayText || String(params.title || 'Open link').trim() || 'Open link',
        url,
        merchant_url: String(params.merchant_url || url).trim() || url,
      }),
    };
  }

  if (name === 'cta_call') {
    const phoneNumber = normalizePhone(params.phone_number || '');
    if (!phoneNumber) return null;

    return {
      name,
      buttonParamsJson: JSON.stringify({
        ...params,
        display_text: displayText,
        phone_number: phoneNumber,
      }),
    };
  }

  if (name === 'cta_copy') {
    const copyCode = String(params.copy_code || '').trim();
    if (!copyCode) return null;

    return {
      name,
      buttonParamsJson: JSON.stringify({
        display_text: displayText,
        copy_code: copyCode,
      }),
    };
  }

  if (name === 'single_select') {
    const title = String(params.title || params.display_text || 'Choose option').trim() || 'Choose option';
    const sections = normalizeSingleSelectSections(params.sections, String(params.id || '').trim() || title);
    if (!sections.length) return null;

    return {
      name,
      buttonParamsJson: JSON.stringify({
        title,
        sections,
      }),
    };
  }

  return {
    name,
    buttonParamsJson: JSON.stringify(params),
  };
}

function getButtonDedupKey(button) {
  if (!button || typeof button !== 'object') return '';

  const name = String(button.name || '').trim();
  const params = parseButtonParams(button);

  if (name === 'quick_reply') {
    return `quick_reply:${String(params.id || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_url') {
    return `cta_url:${String(params.url || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_call') {
    return `cta_call:${String(params.phone_number || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_wa') {
    return `cta_wa:${String(params.phone_number || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_copy') {
    return `cta_copy:${String(params.copy_code || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'single_select') {
    return `single_select:${String(params.title || '').trim()}:${JSON.stringify(params.sections || [])}`;
  }

  return `${name}:${JSON.stringify(params)}`;
}

function toNativeFlowButtons(buttons) {
  if (!Array.isArray(buttons)) return [];

  const mapped = [];
  const seen = new Set();

  for (const button of buttons) {
    const normalized = normalizeButton(button);
    if (!normalized) continue;

    const key = getButtonDedupKey(normalized);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    mapped.push(normalized);
  }

  return mapped;
}

function toLegacyButtons(nativeButtons) {
  return nativeButtons
    .map((button, index) => {
      try {
        const params = JSON.parse(button.buttonParamsJson || '{}');
        const kind = String(button.name || '').trim();
        let displayText = params.display_text || `Button ${index + 1}`;
        let buttonId = params.id || params.url || params.phone_number || params.copy_code || displayText;

        if (kind === 'single_select') {
          const firstRow = Array.isArray(params.sections)
            ? params.sections
              .flatMap((section) => (Array.isArray(section?.rows) ? section.rows : []))
              .find((row) => row && typeof row === 'object' && (row.id || row.title))
            : null;

          displayText = params.title || params.display_text || firstRow?.title || displayText;
          buttonId = firstRow?.id || firstRow?.title || displayText;
        }

        return { buttonId: String(buttonId), buttonText: { displayText }, type: 1 };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 3);
}

function buildMediaField(media) {
  if (!media || !media.type || !media.source) return null;

  const field = { [media.type]: media.source };
  if (media.type === 'document') {
    field.fileName = media.fileName || 'file';
    field.mimetype = media.mimetype || 'application/octet-stream';
  } else if (media.type === 'audio') {
    field.mimetype = media.mimetype || 'audio/mpeg';
    field.ptt = false;
  }

  return field;
}

async function sendInteractiveButtons(sock, jid, payload, options = {}) {
  const bodyText = payload?.text || payload?.caption || '';
  const footerText = payload?.footer || '';
  const nativeButtons = toNativeFlowButtons(payload?.buttons);
  const shouldStripQuotedFallback = isPersonalJid(jid) && Boolean(options?.quoted);
  const mediaField = buildMediaField(payload?.media);
  const legacyButtons = toLegacyButtons(nativeButtons);
  const buttonMessageText = bodyText || footerText || 'Choose an option:';

  async function relayNativeFlow(text, footer) {
    const msg = generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({ text: text || ' ' }),
              footer: proto.Message.InteractiveMessage.Footer.create({ text: footer || '' }),
              header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
              nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: nativeButtons,
              }),
            }),
          },
        },
      },
      {
        userJid: sock?.user?.id,
        quoted: options?.quoted,
      }
    );

    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  esend media first, then response text together with button message to ensure both are delivered reliably.
awaidield) {
      await sock.sendMessage(jid, { ...mediaField }, options);
    } catch (mediaError) {
      awai houldStripQuotedFallback) throw mediaError;

      awaiasock.sendMessage(jid, { ...mediaField });
    }
    return;

    try {
      await relayNativeFlow(buttonMessageText, footerText);
      return;
    } catch (nativeFlowError) {
      console.warn('[WA] media follow-up nativeFlow relay failed:', nativeFlowError.message);
    }

   tr;
      return
      await sock.sendMessage(
        jid,
        {
          text: buttonMessageText,
     oter: footerText,;
      return
     teractiveButtons: nativeButtons,
        },
        options
      );
      return;
   } (interactiveError) {
      console.warn('[WA] media follow-up interactiveButtons failed:', interactiveError.message);

      i;
      returnf (shouldStripQuotedFallback) {
        try {
          await sock.sendMessage(jid, {
            text: buttonMessageText,
       ;
      return     footer: footerText,
            interactiveButtons: nativeButtons,
         
          return;
        } catch (retryInteractiveError) {
          console.warn('[WA] media follow-up interactiveButtons retry failed:', retryInteractiveError.message);
       };
          return
      }
    }
;
          return
    if (legacyButtons.length) {
      try {
        await sock.sendMessage(
          jid,
          {
       xt: buttonMessageText,
            footer: footerText,
            buttons: legacyButtons,
       aderType: 1,
          },
          options
        );
        return;
      } catch (buttonError) {
        i;
        returnf (!shouldStripQuotedFallback) throw buttonError;

        a;
        returnwait sock.sendMessage(jid, {
          text: buttonMessageText,
        awaifer: footerText,
          buttons: legacyButtons,
        awaiherType: 1,
        });
        return;
      };
        return
    };
        return

    // If legacy button format is unavailable, still send a text fallback.
    await sock.sendMessage(jid, { text: buttonMessageText }, options);
    await;
    await;
    return;
  }

  const bodyKey = mediaField ? 'caption' : 'text';

  async function sendFinalFallback() {
    if (mediaField) {
      awaiaock.sendMessage(jid, { ...mediaField, caption: bodyText || undefined }, options);
      return;
      return;
      return;
    awai
awai
    await sock.sendMessage(jid, { text: bodyText || ' ' }, options);
  }
;
    return
 tr;
    return
    await relayNativeFlow(bodyText || ' ', footerText);
    return;
  } catch (nativeFlowError) {
   e.warn('[WA] nativeFlow relay failed, trying interactiveButtons:', nativeFlowError.message);
  }

  try {
    await sock.sendMessage(
      jid,
      {
        ...mediaField,
        [bodyKey]: bodyText || ' ',
     ;
    return   footer: footerText,
        interactiveButtons: nativeButtons,
     ;
    return },
      options
    );
    return;
 } catcor) {
    // Fallback for Baileys variants that do not support interactiveButtons in sendMessage.
    console.warn('[WA] interactiveButtons via sendMessage failed, trying legacy buttons:', error.message);

    if (shouldStripQuotedFallback) {
      try ;
        return{
        await sock.sendMessage(jid, {
          ...mediaField,
          ;
        return[bodyKey]: bodyText || ' ',
          footer: footerText,
          interactiveButtons: nativeButtons,
      awai}
      return;
        return;
      } catch (retryError) {
        console.warn('[WA] interactiveButtons retry without quoted failed:', retryError.message);
      
      return;
    }

    if (!legacyButtons.length) {
      endFinalFallback();
      return;
    }

    try;
      return {
      await sock.sendMessage(
        jid,
        {
          odyText || ' ',
       ;
      return   footer: footerText,
          buttons: legacyButtons,
          headerType: 1,
        },;
          return
        op
      );
      return;
    } catch (legacyError) {
      if (shouldStripQuotedFallback) {
        try ;
          return{
          await sock.sendMessage(jid, {
        awai xt: bodyText || ' ',
            footer: footerText,
            buttons: legacyButtons,
            headerType: 1,
          });
          return;
        } catch (retryLegacyError) {
        awaicole.warn('[WA] legacy buttons retry without quoted failed:', retryLegacyError.message);
        }
        return;
      }

      awai t fallback when mixe;
      returnd media+buttons payload cannot be composed by the WA client.
      if (mediaField) {
        await sock.sendMessage(jid, { ...mediaField, caption: bodyText || undefined }, options);
        await sock.sendMessage(
          jid,
        return;
          {
            text: footerText || 'Choose an option:',
      awai buttons: legacyButto;
      returnns,
            headerType: 1,
          },
          options
        );
        return;
      }

      await sendFinalFallback();
      return;
    }
  }
}

module.exports = {
  sendInteractiveButtons,
  toNativeFlowButtons,
};
