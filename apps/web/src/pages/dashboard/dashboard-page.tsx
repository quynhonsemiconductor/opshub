import { PageHeader } from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { DomainLink, SectionCard, StatTileLink } from './dashboard-widgets';
import { PERSONAS, ROLE_TITLE } from './personas';
import { useDashboardCounts } from './use-dashboard-counts';

/**
 * The persona-aware home screen.
 *
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * Seven persona components, ~500 lines of JSX differing only in which tiles and links they listed —
 * now `personas.ts`, where the differences are the only thing written down. Its own `StatTile` with a
 * bespoke border, skeleton and `ACCENT` map of RAW palette classes (`bg-blue-50 text-blue-600
 * dark:bg-blue-500/15 …`), hand-writing the dark variants the semantic tokens already provide. And
 * five count hooks declared inline, two of which were called by personas that never displayed them.
 *
 * COMPOSITION ONLY: read the role, look up its layout, render the two widgets.
 */
export function DashboardPage() {
  const { primaryRole, isLoading } = usePermissions();
  const counts = useDashboardCounts();

  // `employee` is the fallback, as it was before: an unknown role sees the least privileged layout
  // rather than a blank screen.
  const persona = PERSONAS[primaryRole] ?? PERSONAS.employee;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title={isLoading ? 'Overview' : `Overview · ${ROLE_TITLE[primaryRole] ?? 'Employee'}`}
        description="Operations summary across IT and HR domains."
      />

      {isLoading ? (
        <TileSkeleton />
      ) : (
        <>
          {persona.tiles.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {persona.tiles.map((tile) => {
                const count = tile.count ? counts[tile.count] : undefined;
                return (
                  <StatTileLink
                    key={`${tile.to}:${tile.label}`}
                    to={tile.to}
                    label={tile.label}
                    icon={tile.icon}
                    tone={tile.tone}
                    alert={tile.alert}
                    /*
                     * A FAILED COUNT SAYS SO. `count?.data` is undefined both when a tile carries no
                     * count by design and when its request failed, and `StatCard` renders undefined as
                     * an em dash — so the two were indistinguishable on the first screen anybody sees.
                     * On an alert-styled tile that reads as "nothing awaiting you", which is the
                     * reassuring answer rather than the true one.
                     */
                    value={count?.isError ? 'Unavailable' : count?.data}
                    hint={count?.isError ? 'Couldn’t be read — this is not a zero' : undefined}
                    loading={count?.isLoading}
                  />
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {persona.sections.map((section) => (
              <SectionCard key={section.title} title={section.title} icon={section.icon}>
                {section.links.map((link) => (
                  <DomainLink key={link.to + link.label} {...link} />
                ))}
              </SectionCard>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Four placeholders while the role resolves — the shape the tiles will take, not a spinner. */
function TileSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-border bg-surface-muted"
        />
      ))}
    </div>
  );
}
