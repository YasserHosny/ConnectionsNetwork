import { buildLinkShareMessage, whatsappShareUrl } from './link-share';

const URL_WITH_TOKEN = 'https://app.example.com/c#Tok-en_123';

describe('buildLinkShareMessage', () => {
  it('puts the link in an English message', () => {
    const text = buildLinkShareMessage('en', URL_WITH_TOKEN);

    expect(text).toContain('Hi, I am adding the people I know');
    expect(text.endsWith(URL_WITH_TOKEN)).toBeTrue();
  });

  it('puts the link in an Arabic message whatever the app language is', () => {
    const text = buildLinkShareMessage('ar', URL_WITH_TOKEN);

    expect(text).toContain('أهلًا');
    expect(text).toContain(URL_WITH_TOKEN);
  });

  it('keeps a link that contains placeholder syntax exactly as given', () => {
    const odd = 'https://app.example.com/c#{{url}}';

    expect(buildLinkShareMessage('en', odd).endsWith(odd)).toBeTrue();
  });
});

describe('whatsappShareUrl', () => {
  it('opens WhatsApp with the text and no recipient: the admin picks the chat there', () => {
    const text = buildLinkShareMessage('en', URL_WITH_TOKEN);

    expect(whatsappShareUrl(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`);
  });
});
