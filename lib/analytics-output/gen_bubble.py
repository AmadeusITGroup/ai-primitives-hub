#!/usr/bin/env python3
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

data = [
    ("amadeus-microservice\ncoding-guidebook", 178, 5833.3, 175),
    ("airline-solutions\narchitecture", 80, 1233.3, 74),
    ("archreview", 63, 350.0, 49),
    ("foursight-code\nassessment", 28, 180.0, 18),
    ("opentelemetry\ntracing-toolkit", 19, 171.4, 12),
    ("refx-nre-qa-agents", 31, 138.5, 18),
    ("cnadocs", 75, 120.6, 41),
    ("pr-review", 129, 111.5, 68),
    ("java-engineering", 107, 109.8, 56),
    ("batch-elasticity", 6, 100.0, 3),
    ("dsre-git-skillset", 19, 72.7, 8),
    ("etk-workflow", 38, 65.2, 15),
    ("agents-md-creator", 16, 60.0, 6),
    ("rail-obe-context", 11, 57.1, 4),
    ("slidev", 53, 51.4, 18),
    ("skubedocs", 170, 50.4, 57),
    ("pr-reviewer-generator", 97, 44.8, 30),
    ("reflex", 119, 25.3, 24),
    ("log-verbosity-reduction", 79, 21.5, 14),
    ("aude", 53, 20.5, 9),
    ("amadeus-ospo", 62, 19.2, 10),
    ("workflow-nevio", 782, 17.1, 114),
    ("task-driven-agents", 77, 8.5, 6),
]

labels = [d[0] for d in data]
x = np.array([d[1] for d in data])  # May downloads
y_raw = np.array([d[2] for d in data])  # growth %
delta = np.array([d[3] for d in data])  # absolute delta

# bubble size: scale delta to visible range
bubble_size = (delta / delta.max()) * 3000 + 100

# colors: highlight top growers
colors = []
for i, (lbl, may, growth, d) in enumerate(data):
    if growth >= 1000:
        colors.append('#E63946')   # red - extreme outliers
    elif growth >= 200:
        colors.append('#F4A261')   # orange - high growth
    elif growth >= 50:
        colors.append('#2A9D8F')   # teal - solid growth
    else:
        colors.append('#7B9AD0')   # blue - moderate

fig, ax = plt.subplots(figsize=(8.8, 4.8))
fig.patch.set_facecolor('#FFFFFF')
ax.set_facecolor('#F8F9FC')

scatter = ax.scatter(x, y_raw, s=bubble_size, c=colors, alpha=0.75,
                     edgecolors='white', linewidths=1.2, zorder=3)

# log scale y (outliers compress nicely)
ax.set_yscale('log')

# grid
ax.grid(True, which='major', linestyle='--', linewidth=0.5, color='#CADCFC', alpha=0.6, zorder=1)
ax.grid(True, which='minor', linestyle=':', linewidth=0.3, color='#CADCFC', alpha=0.3, zorder=1)

# axes labels & style
ax.set_xlabel('Total downloads (May 21)', fontsize=9, color='#4A5568', labelpad=4)
ax.set_ylabel('% growth (Apr 23 → May 21)', fontsize=9, color='#4A5568', labelpad=4)
ax.tick_params(colors='#4A5568', labelsize=7.5)
for spine in ax.spines.values():
    spine.set_edgecolor('#CADCFC')

# annotate top bundles (avoid overcrowding)
annotate_idx = [i for i, d in enumerate(data) if d[2] >= 100 or d[1] >= 100]
for i in annotate_idx:
    lbl = labels[i]
    ax.annotate(lbl, (x[i], y_raw[i]),
                xytext=(6, 4), textcoords='offset points',
                fontsize=6.5, color='#1E2761',
                ha='left', va='bottom')

# legend
legend_elems = [
    mpatches.Patch(color='#E63946', label='>1000% growth'),
    mpatches.Patch(color='#F4A261', label='200–1000%'),
    mpatches.Patch(color='#2A9D8F', label='50–200%'),
    mpatches.Patch(color='#7B9AD0', label='<50%'),
]
ax.legend(handles=legend_elems, fontsize=7, loc='upper right',
          framealpha=0.9, edgecolor='#CADCFC')

# bubble size legend note
ax.text(0.01, 0.02, 'Bubble size = absolute download gain (Δ)',
        transform=ax.transAxes, fontsize=6.5, color='#4A5568', va='bottom')

plt.tight_layout(pad=0.8)
plt.savefig('bubble_chart.png', dpi=150, bbox_inches='tight',
            facecolor='white', edgecolor='none')
print("Saved bubble_chart.png")
