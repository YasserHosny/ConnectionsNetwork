/** Layout shared by the three review lists (duplicates, stale, unreachable). */
export const REVIEW_LIST_STYLES = `
  :host {
    display: block;
    max-inline-size: 900px;
  }
  p {
    margin: 0;
  }
  .intro,
  .empty,
  .detail {
    color: var(--mat-sys-on-surface-variant);
  }
  .intro {
    margin-block-end: 16px;
  }
  .status,
  .error {
    margin-block-end: 12px;
  }
  .error {
    color: var(--mat-sys-error);
  }
  .people {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .person {
    display: grid;
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--mat-sys-outline-variant);
    border-radius: 12px;
    background: var(--mat-sys-surface-container-low);
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
  }
  .name {
    font: var(--mat-sys-title-medium);
    color: inherit;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (min-width: 700px) {
    .person {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }
  }
`;
