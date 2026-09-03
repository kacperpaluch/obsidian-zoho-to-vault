# Zoho to Vault

Wtyczka do Obsidiana: wiadomości z Zoho Mail lądują w vaulcie jako notatki.
Po REST API, więc działa tak samo na desktopie i na iOS/Androidzie (IMAP na mobile odpada).

## Instalacja

### BRAT (zalecane — aktualizacje same)

1. Zainstaluj [BRAT](https://github.com/TfTHacker/obsidian42-brat) z Community plugins.
2. `Cmd+P` → **BRAT: Add a beta plugin for testing** → wklej:

   ```
   kacperpaluch/obsidian-zoho-to-vault
   ```

3. Włącz **Zoho to Vault** w Community plugins.

BRAT sam sprawdza nowe wydania i podbija wersję. Działa też na mobile.

### Ręcznie

Pobierz `zoho-to-vault.zip` z [ostatniego wydania](https://github.com/kacperpaluch/obsidian-zoho-to-vault/releases/latest),
rozpakuj do `<vault>/.obsidian/plugins/` i włącz w Community plugins.
Bez builda — `main.js` to gotowy plik, więc równie dobrze możesz skopiować `main.js` i `manifest.json` prosto z repo.

## Konfiguracja

1. [Zoho API Console](https://api-console.zoho.eu/) → **Self Client** → Create.
2. Zakładka **Generate Code**:
   - Scope: `ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ`
   - Duration: 10 min → **Create** → skopiuj kod.
3. Wymień kod na refresh token (raz, bezterminowy):

   ```bash
   curl -s -X POST "https://accounts.zoho.eu/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=CLIENT_ID" \
     -d "client_secret=CLIENT_SECRET" \
     -d "code=KOD"
   ```

4. Wklej client ID / secret / refresh token w ustawieniach wtyczki, wybierz data center,
   kliknij **Testuj**. Account ID wykryje się samo.

Sekrety **nie trafiają do `data.json`**, więc nie jadą przez sync vaulta: na macOS lądują
w pęku kluczy (`security`, usługa `obsidian-zoho-to-vault`), na mobile w `localStorage`
urządzenia. Skutek uboczny: na każdym urządzeniu wklejasz je raz osobno.

## Filtrowanie po nadawcy

Dwie drogi:

- **Filtr w ustawieniach wtyczki** — adresy po przecinku, dopasowanie po fragmencie `fromAddress`.
- **Reguła w Zoho** (zalecane) — „od X → przenieś do folderu `Obsidian`", a we wtyczce
  ustawiasz ten folder i zostawiasz filtr pusty. Mniej odpytywania, filtrowanie po stronie serwera.

## Ograniczenia

- **Na mobile nie ma tła.** Odpytywanie leci tylko przy otwartym Obsidianie — mail trafi do vaulta
  przy najbliższym uruchomieniu appki, nie w momencie doręczenia.
- Pierwsze uruchomienie zaciąga do 50 ostatnich pasujących wiadomości z folderu.
- Bez załączników, bez oznaczania jako przeczytane, bez szablonów nazw notatek.
- Wszystkie tabele HTML są rozpakowywane do tekstu — maile używają ich do układu strony,
  a nie do danych. Treść zostaje, ginie tylko siatka.
- Grafiki są wyjmowane z linków (`[![[x.png]]](url)` się nie renderuje), a linki śledzące
  wokół samych obrazków znikają.
- Komenda **Zoho: test konwersji HTML** sprawdza tę logikę na miejscu, w konsoli.
- Deduplikacja po `messageId`, pamięć ostatnich 500 w `data.json`.
