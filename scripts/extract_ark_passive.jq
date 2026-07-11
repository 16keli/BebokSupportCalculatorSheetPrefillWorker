# Extract all Ark Passive nodes from raw_data/ArkPassive.json into a
# data/ark_passive.json-shaped file, but covering every node/class (not just
# the previously hand-curated subset).
#
# Usage:
#   jq -f scripts/extract_ark_passive.jq \
#     --slurpfile known data/ark_passive.json \
#     --slurpfile ability raw_data/Ability.json \
#     --slurpfile combatEffect raw_data/CombatEffect.json \
#     --slurpfile addonSkillFeature raw_data/AddonSkillFeature.json \
#     --slurpfile skill raw_data/Skill.json \
#     raw_data/ArkPassive.json > data/ark_passive_full.json
#
# Caveats (raw data only has `id` + `levels`, nothing else):
#  - evolution.tier is derivable (universal 6-prefix -> tier mapping) and is filled in.
#  - enlightenment tier/type are NOT derivable from raw data alone (the id-offset
#    -> tier/type layout differs per class, e.g. Bard's 12 nodes are sequential
#    pairs per tier while Artist's are a support/non-support 6+6 split) -- these
#    keys are omitted entirely (rather than emitted as null) since they're
#    unknown, not "false".
#  - enlightenment.support IS hardcoded from the existing data/ark_passive.json
#    (passed in via --slurpfile known) for every id already curated there. Since
#    `false` is the default, a hardcoded `false` is omitted entirely -- only
#    `support: true` is ever emitted.
#  - The per-class "Awakening tripod" nodes at offsets 5000/5100/5200/5300/5500/
#    5600-5900 (Transcendent Power, Charged Fury, etc.) are excluded; only the
#    offset 5400 "Release Potential" nodes (+ the 2315600 Dragon Gem exception)
#    are treated as "leap", and only offsets 0-1100 are treated as
#    "enlightenment", matching the shape of the existing curated file.
#  - Nodes whose name is null in every level (e.g. 1031100-1031600, which have
#    no name/desc/icon at all in the raw data) are excluded entirely.
#  - effects tabulates each level's addons: `type` + (for "stat" addons)
#    `statType` name the effect, `value` is the addon's keyValue (the direct
#    numeric magnitude for stat/attack_power_amplify_multiplier/mana_reduction/
#    skill_cooldown_reduction/skill_group_* addons). Where the addon's
#    keyIndex is a foreign key into another raw_data table, that row is joined
#    in under `resolved` when found:
#      - ability_feature  -> Ability.json[keyIndex]        (name/featureType/
#                             the specific level entry at keyValue)
#      - combat_effect    -> CombatEffect.json[keyIndex]    (raw effects list;
#                             no single numeric value, kept as structured data)
#      - skill_feature    -> AddonSkillFeature.json[keyIndex] (name/desc/type/
#                             parameters)
#      - skill_cooldown_reduction -> Skill.json[keyIndex]   (skill name), when
#                             keyIndex is a real skill id (0 = not applicable)
#    `resolved` is omitted when the keyIndex isn't found in that table (e.g. a
#    handful of ability_feature/skill_feature ids not present in this data
#    dump) or when no join table is known for that addon type
#    (skill_group_cooldown_reduction/skill_group_damage/
#    skill_group_party_without_self_shield reference skill-group ids that
#    aren't resolvable against any table in raw_data/).

def evoTier:
  (tostring | .[0:4]) as $p
  | if $p == "1010" then 1
    elif $p == "1020" then 2
    elif $p == "1030" or $p == "1031" then 3
    elif $p == "1032" or $p == "1040" then 4
    else null
    end;

($ability[0]) as $Ability
| ($combatEffect[0]) as $CombatEffect
| ($addonSkillFeature[0]) as $AddonSkillFeature
| ($skill[0]) as $Skill
| def resolveAbilityFeature($keyIndex; $keyValue):
    $Ability[$keyIndex | tostring] as $ab
    | if $ab == null then null
      else
        {name: $ab.name, featureType: $ab.featureType}
        + ($ab.levels[$keyValue | tostring] as $lvl
           | if $lvl == null then {} else {desc: $lvl.desc, values: $lvl.values} end)
      end;
  def resolveCombatEffect($keyIndex):
    $CombatEffect[$keyIndex | tostring] as $ce
    | if $ce == null then null else {effects: $ce.effects} end;
  def resolveSkillFeature($keyIndex):
    $AddonSkillFeature[$keyIndex | tostring] as $af
    | if $af == null then null
      else {name: $af.name, desc: $af.desc, type: $af.type, parameters: $af.parameters}
      end;
  def resolveSkill($keyIndex):
    $Skill[$keyIndex | tostring] as $sk
    | if $sk == null then null else {skillName: $sk.name} end;
  def addonEffect:
    {type}
    + (if .type == "stat" then {statType} else {keyIndex} end)
    + {value: .keyValue}
    + (
        (if .type == "ability_feature" then resolveAbilityFeature(.keyIndex; .keyValue)
         elif .type == "combat_effect" then resolveCombatEffect(.keyIndex)
         elif .type == "skill_feature" then resolveSkillFeature(.keyIndex)
         elif .type == "skill_cooldown_reduction" then resolveSkill(.keyIndex)
         else null
         end) as $resolved
        | if $resolved == null then {} else {resolved: $resolved} end
      );
  def levelEffects:
    . as $levels
    | ($levels | keys_unsorted | map(tonumber) | sort | map(tostring)) as $order
    | reduce $order[] as $lvl ({}; . + {($lvl): ($levels[$lvl].addons // [] | map(addonEffect))});
  ($known[0].enlightenment
    | to_entries
    | map(select(.value.support == true) | {key, value: true})
    | from_entries
  ) as $knownSupport
| [
    to_entries[]
    | (.key | tonumber) as $id
    | (.value.levels."1".name // (.value.levels | to_entries[0].value.name)) as $name
    | select($name != null)
    | {id: $id, name: $name, effects: (.value.levels | levelEffects)}
  ] as $nodes
| {
    evolution: (
      [ $nodes[]
        | select(.id < 2000000)
        | {key: (.id | tostring), value: (. + {tier: (.id | evoTier)})}
      ]
      | from_entries
    ),
    enlightenment: (
      [ $nodes[]
        | select(.id >= 2000000)
        | select((.id % 10000) < 1200)
        | {
            key: (.id | tostring),
            value: (
              . + (if $knownSupport[(.id | tostring)] then {support: true} else {} end)
            )
          }
      ]
      | from_entries
    ),
    leap: (
      [ $nodes[]
        | select(.id >= 2000000)
        | select(((.id % 10000) == 5400) or .id == 2315600)
        | {key: (.id | tostring), value: .}
      ]
      | from_entries
    )
  }
