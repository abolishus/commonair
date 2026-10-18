// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package receipts

import (
	"crypto/ed25519"

	"github.com/abolishus/commonair/relay/internal/accounting"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// MaxEntriesPerReceipt keeps each receipt well under the API's 4 MB payload
// limit (an entry is about 90 bytes, base64 adds a third).
const MaxEntriesPerReceipt = 20_000

// Built is one signed receipt and its nonce.
type Built struct {
	Nonce   string
	Receipt tokens.SignedReceipt
}

// Build signs the receipts for a closed period: one per chunk of entries,
// each with a fresh random nonce. An empty period yields no receipts.
//
// Receipts are MEDIA-ONLY by decision: bytes and segments cover media
// objects (segments, parts, init sections) and never playlists, because the
// origin's issuance log, the ground truth receipts are cross-checked
// against, counts media objects the same way. A segment counts once it was
// delivered completely; bytes count as they are flushed to the viewer.
func Build(key ed25519.PrivateKey, relayID string, p accounting.Period, chunk int) ([]Built, error) {
	if chunk <= 0 || chunk > tokens.MaxReceiptEntries {
		chunk = MaxEntriesPerReceipt
	}
	var out []Built
	for start := 0; start < len(p.Entries); start += chunk {
		end := min(start+chunk, len(p.Entries))
		nonce, err := tokens.NewNonce()
		if err != nil {
			return nil, err
		}
		signed, err := tokens.SignReceipt(key, tokens.ReceiptPayload{
			V:           1,
			RelayID:     relayID,
			Nonce:       nonce,
			PeriodStart: tokens.ISOTime(p.Start),
			PeriodEnd:   tokens.ISOTime(p.End),
			Entries:     p.Entries[start:end],
		})
		if err != nil {
			return nil, err
		}
		out = append(out, Built{Nonce: nonce, Receipt: signed})
	}
	return out, nil
}
