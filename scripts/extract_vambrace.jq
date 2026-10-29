# Extract vambrace item id -> grade from raw_data/Item.json into
# data/vambrace.json. Vambraces are equipment category 10206 ("bracer" slot in
# lostark.bible snapshots); the grade picks the sheet's level-dropdown suffix
# (epic / leg. / relic / ancient - see configs/spreadsheet/expr/vambraceLabel.ts).
#
# Usage:
#   jq -S -f scripts/extract_vambrace.jq raw_data/Item.json > data/vambrace.json
with_entries(select(.value.category == 10206)) | map_values(.grade)
