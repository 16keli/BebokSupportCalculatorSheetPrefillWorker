# What

Planning different data sources required to fill out the bebok sheet.

## Version
This table assumes the following versions:
Entity | Affects | Version
-|-|-
Bebok Calculator | Cell Mappings | 3.8.1
LOA Logs | Log Datasource | <= 1.46.0
Bible Snapshots | Snapshot Datasource | v3

## Json Paths

Json data paths will be defined using json path syntax. The following prefixes are implicit for each data source:

Data Source | Implicit Prefix | Comments
-|-|-
Log | `data[0].encounterInfo.encounter` |
Snapshot | `data[1].data.snapshot` |
Loadout | `data[2].data` | Might need to modify more, there are other fields

## External Data Sources
Consider building an external database, potentially bundle it with the release. Lostarkcodex could help temporarily.

## Data

### Character
Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Class | `F2` | Log | `entityList[*].classId` | 
Gear | `F6:G11` | Snapshot | `items[*].data.honing`, `items[*].data.advancedHoning` | Filter by `slot`, there's gear and accessories. 
Gear Tier | `E6:E11` | Snapshot | `items[*].id` | TODO Need map of item id (gear) to gear tier
Combat Stats sans Bracelet (Spec, Swift) | `F14, F15` | Snapshot | `arkPassive.evolution[*].level` | Ark passive: `id = 1010200` for spec, `id = 1010400` for swift.  External input needed: Fill in base stats with both pet and roster wide bonuses (default to max, reasonable?)
Identity Base | `F16` | User Input | N/A | Only varies for bard. Depends on what level buff is being sent. Default to 3 bars?
Skin Bonus | `F18` | Loadout | `loadouts[x].items[*].id` | TODO Need map of item id (skin) to skin rarity
Stone Bonus | `F19` | Snapshot | `items[*].id.data.engravings[*].nodes` | Manually compute whether this qualifies as 9/7 or 10/6. Filter on `ability_stone`. TODO figure out how to exclude negative on stone from counting, perhaps on `id`?
Karma Evolution Rank | `F21` | Snapshot | `karma.evolution` | Table of cutoffs to actual rank, since it gives the level and not rank. Also technically this isn't recorded lmfao. We'll just assume that it's unlocked...
Karma Enlightenment Rank | `F22` | Snapshot | `karma.enlightenment` |

### Results
Value | Cell | Data Source | Path | Comments
-|-|-|-|-
DPS Value | `L2:M2` | Log | N/A | Use default serca or prefill this? Gulp
Content Type | `L31:M31` | Log | `currentBossName` | TODO Need map of boss name to boss or content type

### Ark Grid
TODO Need to build logic for validity of ark grid. This is needed to calculate astrogem and core totals.

This also requires more datamining gulp.

Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Astrogem Effects | `Z4:Z6` | Snapshot | `arkGridCores[*].gems[*].opts[*].level` | Need to manually sum all astrogems options together. `id = 2011` ally dmg, `id = 2012` brand, `id = 2013` ally atk.
Core Totals | `AB11`, `AB21`, `AG4`, `AG13`, `AG22` | Snapshot | `arkGridCores[*].gems[*].opts[*].level` | Manual calculation
Core Type | `Y15:AB16`, `Y25:AB26`, `AF4`, `AF13`, `AF22` | Snapshot | `arkGridCores[*].id` |

### Ark Passive
Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Enlightenment Nodes | `AM6:AM9`, `AM12:AM13` | Snapshot | `askPassive.enlightenment[*].level` | TODO Filter on `id` to determine main vs side
Evolution Nodes | `AM17:AM19`, `AM23:AM25`, `AM29:AM31` | Snapshot | `arkPassive.evolution.[*].level` | TODO Filter on `id` to determine which is which

### Accessories
Common notes:

* Filter to the appropriate piece, dummy
* `index = 151` flat weapon power, `value` is the fixed amount

Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Necklace Lines | `AU3:AU5` | Snapshot | `items[*].data.stats[*].index`, `items[*].data.stats[*].value` | `index = 46` brand power, value is its value. `index = 6002` meter high, `index = 6001` meter mid, `index = 6000` meter low, value is ignored xd.
Earring Lines | `AU9:AU11`, `AW9:AW11` | Snapshot | `items[*].data.stats[*].index`, `items[*].data.stats[*].value` | `index = 152` weapon power %, `value` is the percentage (times 100)
Ring Lines | `AU15:AU17`, `AW15:AW17` | Snapshot | `items[*].data.stats[*].index`, `items[*].data.stats[*].value` | `index = 16000001` ally dmg, `value` is percentage (times 100). `index = 0` ally atk, `value` is percentage (times 100)
Accessory Main Stat | `AU6`, `AU12`, `AW12`, `AU18`, `AW18` | Snapshot | `items[*].data.stats[*].value` | Repeated 3 times, maybe for a range? For `index = 3, 4, 5`. Probably just take 4...
Bracelet | `AU22:AU24`, `AU25:AW27` | Snapshot | `items[*].data.stats[*].index`, `items[*].data.stats[*].value` | See below table xd

#### Bracelet Stats Table xd
Bracelet bonus | `index` | Comments
-|-|-
Spec | 16 | 
Swift | 18 | 
Main Stat | 11 | Applies to all main stat types
Crit Dmg | 11091 - 11093 | High to low
Crit Rate | 11071 - 11073 | High to low
Def | 605100171 - 605100173 | High to low
Cheers | 11081 - 11083 | High to low
Ally Atk | 0 | Value is strength in percent (times 100)
Ally Dmg | 16000001 | Value is strength in percent (times 100)
WP + 50% HP | 11111 - 11113 | High to low
Stacking WP | 11121 - 11123 | High to low
WP | 151 | Value is amount
WP + ASMS Stacking | 605100101 - 605100103 | High to low

### Gems & Skills & CDRs
Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Skill Dmg and CD Gems | `BB3:BC11` | Snapshot | `gem.effects[*].value` | Look based on type: `5` is skill damage, `27` is skill CDR, `65` for identity strength. Can infer gem level based on these values
Cooldowns | `BD3:BD11` | Snapshot | `skills[*].id` | Tripods in `SkillFeature.json`, look for `reduce_default_cooldown` entries. T-Skill is (kinda) included in snapshot, but all T skills and awakenings are included. Probably should just hardcode this based on class xd
Core CDR | `BE3:BE10` | N/A | N/A | Not sure where this comes in. Ignore for now, not *that* consequential
Buff Skill Level | `BB17:BB18` | Snapshot | `skills[*].level` | Maybe surface a notice if it's not max level (level // 5)
Uptime Proportion | `BC17` | Log | `entityList[*].damageStats.buffedBySupport` | See below...
Engraving Book Levels | `BB21`, `BB24` | Snapshot | `engravings` | `grade` and `progress` combine to give level. `grade = engrave_grade05` for full relic (Relic 20), otherwise `grade = engrave_grade04` and `progress` gives the amount of books, round down if necessary.
Awakening Rock Level | `BC24` | Snapshot | `items[*].data.engravings[*].nodes` | Filter to `id = 255` for awakening engraving
Leap CDR | `BB27`, `BB28` | Snapshot | `arkPassive.leap[*].level` | Filter to `id = 2215400` for the common node. For artist, also look for `id = 2310500`

#### Attack Buff Categorization
Complicated. See https://github.com/snoww/loa-logs/blob/master/src/lib/utils/buffs.ts#L349 for the attack power grouping if it ever changes. Currently it's defined as:

```
atkPwrGrp: [
  101105, // Pala atk power
  314004, // Artist atk power
  101204, // Bard atk power
  480030 // Valkyrie atk power
],
```

To find a list of appropriate buffs, we must filter by `encounterDamageStats.buffs.uniqueGroup` to see which of these values to look for.

To attribute this to a specific skill, we must further look at `source.skill.id`. Consider hardcoding the skill ids?

### Uptimes and Other
Value | Cell | Data Source | Path | Comments
-|-|-|-|-
Fixed Bonuses | `BJ2:BJ7` | Loadout / User Input? | N/A | Hard to infer. Maybe use a reasonable default? idk
AP Buff Uptime | `BJ11` | Log | `entityList[*].damageStats.buffedBySupport` | 
Brand Uptime | `BJ12` | Log | `entityList[*].damageStats.debuffedBySupport` |
Identity Uptime | `BJ13` | Log | `entityList[*].damageStats.buffedByIdentity` |
T Uptime | `BJ14` | Log | `entityList[*].damageStats.buffedByHat` | 
Major Chord Uptime | `BJ15` | Log | `entityList[*].damageStats.buffedBy[*]` | Bard only. Similar to attack buff categorization above, see buffs of category `214020` (currently `214020` - `214028`)
Wings of Freedom Uptime | `BJ15` | Log | `entityList[*].damageStats.buffedBy[*]` | Valk only. Similar to attack buff categorization above, see buffs of category `480024` (currently `480024`, `480025`, `480026`)
Cheers Uptime | `BJ16` | Log | `entityList[*].damageStats.buffedBy[*]` | Buffs of category `605100081`
Strength Orb Uptime | `BJ17` | Log | `entityList[*].damageStats.buffedBy[*]` | Buffs of category `523401`
Flash Orb Uptime | `BJ18` | Log | `entityList[*].damageStats.buffedBy[*]` | Buffs of category `523501`

#### Calculating Fixed Damage
Hyper awakening damage is `entityList[*].damageStats.hyperAwakeningDamage`.

Fixed damage from other sources is at `entityList[*].skills[*]` and look for any marked as `special: true`.

## Misc Notes area

Ark grid `coreType` seems to have values 0 and 1 corresponding to the appropriate spec
If we have cores of the wrong spec in, what happens?
* Core effects definitely not active
* What about astrogems though?
