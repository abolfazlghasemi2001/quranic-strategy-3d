# ممیزی شهر نور — ۲۰۲۶-۱۰-۰۹

مبنای کد: `9b64be982aad3dc1fe03652afc048779172fe4b8` (همان HEAD سرور main در زمان ممیزی).
کار در شاخهٔ ثابت نشست Arena انجام می‌شود؛ شاخهٔ main دست‌نخورده است. این سند پیش از تغییر کد اجرایی ثبت شد؛ ستون وضعیت در پایان کار به‌روز می‌شود.

## پایه و حدود شواهد

- `npm ci`: موفق؛ audit نصب هیچ آسیب‌پذیری گزارش نکرد.
- `npm test`: **۱۱۲ self-check و ۵۸ آزمون واحد** موفق.
- `npm run smoke`: موفق؛ در نسخهٔ پایه smoke مستقلی برای پنل نبرد وجود ندارد.
- `npm run build`: موفق؛ **328.16 kB gzip JS**، CSS **12.44 kB gzip**. عدد تاریخی 288.6 مبنای این checkout نیست.
- `npm run test:pwa`: موفق؛ فقط بررسی ایستای ۱۵ فایل precache، نه نصب واقعی.
- `npm run test:hud`: نخست exit 2 (Chromium نصب نبود). پس از نصب محلی `@sparticuz/chromium`، **۱۶۹/۱۶۹** بررسی چیدمان موفق.
- تمام ۱۴۵ فایل متنی `src/`, `server/`, `tools/`, `tests/` خوانده/اسکن و JSONها parse شدند؛ فهرست SHA-256، import/export و نقاط مرزی در `source-inventory.json` است. مرور عمیق بر مسیرهای نبرد، رندر، dispose، بارگذاری داده، شبکه و HUD متمرکز بود.
- Chromium با WebGL2 و ANGLE/SwiftShader، viewport 412×915، DPR 1؛ ۲ ثانیه warmup و ۶ ثانیه نمونهٔ هر حالت. ۱۸ حالت: سه سناریو × سه کیفیت × CPU 1×/4×. FPS از فاصلهٔ **رندرهای واقعی** است، نه شمار callbackهای rAF. p1 = 1000/p99 فاصلهٔ فریم. heap از CDP پس از GC؛ **VRAM نیست**.
- اجرای آزمایشی نخستِ ابزار performance به‌دلیل نام اشتباه event ساختمان کنار گذاشته شد؛ تنها اجرای اصلاح‌شده با assertion تطابق تعداد rootهای دیداری و ساختمان‌های state در گزارش آمده است.
- خروجی‌های خام و تصاویر: `docs/upgrade/before/`. نه FPS، نه heap، نه draw calls این محیط را معادل گوشی واقعی تلقی کنید.

## جدول یافته‌ها

| شناسه | شدت | مورد / تأیید یا رد | علت ریشه‌ای | وضعیت پیش از اصلاح |
|---|---|---|---|---|
| SEC-01 | P0 | **تأیید**: `?social=wss://external.invalid/social-ws` پذیرفته می‌شود؛ auto-connect می‌تواند token ذخیره‌شده و مشخصات شهر را به همان endpoint بفرستد | Config فقط regex پروتکل دارد؛ SocialSystem هم هیچ مرز origin ندارد | باز |
| SEC-02 | P1 | **تأیید**: `?quran=https://external.invalid/quran.json` بدون checksum پذیرفته می‌شود | resolveUrl هر override را برمی‌گرداند؛ فقط محتوای JSON بررسی می‌شود | باز |
| WS-01 | P1 | **تأیید**: unmasked، RSV، continuation یتیمِ FIN، text جدید وسط fragment، ping fragmented و UTF-8 نامعتبر پذیرفته می‌شوند | parser قرارداد RFC6455 را کامل enforce نمی‌کند؛ اعتبارسنجی header دیر انجام می‌شود | باز |
| WS-02 | P1 | **تأیید با مسیر کد**: frame ناقص connection را بدون deadline نگه می‌دارد؛ cap اتصال/IP و backpressure وجود ندارد | buffer concat، socket.end بدون force deadline، نوشتن نامحدود | باز؛ آزمون fuzz/deadline لازم |
| WS-03 | P3 | **رد شد**: opcode 3 و frame با length بزرگ در parser قبول نمی‌شوند | مسیر خطا اتصال را می‌بندد؛ ولی حد تجمعی fragments/close code باید تقویت شود | پوشش regression لازم |
| BTL-01 | P1 | **تأیید**: دو برج + raid-column، seed 33 → timeout و ۲۰۴ ضربه پس از آخرین برج | پایان فقط شمار مهاجم/سقوط مرکز/سه سازه/timeout را می‌سنجد؛ برای ستون ضعیفِ بی‌هدف اولویت‌دار قاعدهٔ ترک میدان نیست | باز |
| BTL-02 | P1 | **تأیید با مسیر کد**: عقب‌نشینی پنل را hide می‌کند، اما session/view/HUD باقی می‌مانند؛ نتیجهٔ replay دوباره liveBox را آشکار می‌کند | hide با closeSession فرق دارد؛ show براساس active تصمیم می‌گیرد نه done | نیازمند آزمون شکست‌خوردهٔ smoke |
| SHD-01 | P1 | **تأیید اندازه‌گیری**: sun حرکت می‌کند، shadow matrix بعد از cadence تغییر نمی‌کند | `renderer.shadowMap.autoUpdate=false`؛ World تنها `sun.shadow.needsUpdate` می‌زند، نه dirty سراسری؛ low→medium نیز camera سایه initialize نمی‌شود | باز؛ ادعای «شیمر» روی گوشی اندازه‌گیری‌نشده |
| PERF-01 | P1 | **تأیید**: شهر ۳۰ ساختمان ۳۰ root دارد، **305 calls**؛ نبرد **316 calls** | هر جزء ساختمان Mesh جداست؛ material مشترک به‌تنهایی draw call را کاهش نمی‌دهد | باز |
| LOOP-01 | P2 | **تأیید با کد، آزمون زمان‌بندی لازم**: cap عادی ۶۰ با `next=now+interval` فاز را از دست می‌دهد و امکان نصف‌شدن نرخ در rAF jitter دارد | limiter به جای حفظ فاز به callback جاری قفل می‌شود | باز؛ سقف عمدی ۳۰ تنها batterySaver است |
| LOOP-02 | P2 | **تأیید با کد**: تب hidden رسم نمی‌شود، ولی rAF همچنان reschedule و stats به‌روز می‌شوند | pause فقط sim/render را می‌بندد، نه زمان‌بندی | باز |
| GPU-01 | P2 | **رد شد در محدودهٔ آزمون**: رشد پیوسته هنگام ۱۰ چرخهٔ پنل/نبرد procedural دیده نشد (۱۴ geometry /۴ texture ثابت) | cacheهای گرم و poolها عمداً حفظ می‌شوند | روی GPU واقعی/چرخهٔ طولانی اندازه‌گیری‌نشده |
| GPU-02 | P2 | **تأیید با مالکیت کد**: CharacterEntity هنگام dispose، skeleton/boneTexture کلون را آزاد نمی‌کند؛ GLTF نامعتبر پس از parse هم dispose نمی‌شود | cleanup فقط root.clear و mixer است | آزمون dispose لازم؛ اندازهٔ VRAM اندازه‌گیری‌نشده |
| CHAT-01 | P2 | **تأیید**: حروف یک واژهٔ blocklist با فاصله از filter می‌گذرند؛ اعراب/کشیده/ZWNJ عادی در پایه مسدودند | split به token پیش از canonical matching | باز |
| HUD-01 | P3 | **رد شد در اندازه‌های آزمایش‌شده**: RTL، 360×640 (بزرگ‌ترین قلم)، 412×915، 844×390 و 768×1024 overflow ندارند؛ matrix فعلی 169/169 سبز است | چیدمان موجود سالم است؛ ابزار هنوز 360×640 و safe-area مصنوعی را assert نمی‌کند | گسترش پوشش لازم، نه بازطراحی بی‌دلیل |
| DOC-01 | P3 | **رد شد**: «فاز ۵ در main نیست» نادرست است، هرچند PR #5 Open است | کد و تست‌های فاز ۵ و ۶ در همان commit فعلی موجودند؛ وضعیت PR شاهد غیبت کد نیست | README فاقد بخش روشن این دو فاز است |
| DATA-01 | P2 | **تأیید**: reviewed=true با رکورد مالک/مقایسهٔ مکانیکی موجود است؛ مدرک بازبینی دینی/حقوقی مستقل واجد صلاحیت در ریپو نیست | سند بعضی محدودیت‌ها را به توصیه تقلیل داده؛ matching مکانیکی جای بررسی انسانی نیست | reviewed دست‌نخورده؛ گزارش و README باید صریح شوند |
| ARCH-01 | P2 | **تأیید**: game مستقیماً window.location و navigator.vibrate را می‌خواند | default endpoint و haptics در لایهٔ منطق جای گرفته‌اند | باید از composition/core تزریق یا event شوند |

## بازتولیدهای دقیق

### BTL-01

1. شهر: town-center سطح ۱ در `(19,19)`, size `[3,3]`؛ دو watchtower سطح ۱ در `(17,17)` و `(17,23)`, size `[2,2]`؛ garrison خالی.
2. `buildScenario(... encounterId:'raid-column', seed:33)` و `BattleSim.runToEnd()` با battle.json پایه.
3. آخرین برج در tick 1152 می‌افتد؛ نتیجه در tick 3000 = timeout؛ ۵ مهاجم left؛ مرکز hp=384/2800؛ stateHash=1226110089، eventHash=214625525.
4. `tests/fixtures/battle-v1.json` ضبط حقیقی نسخهٔ پایه است. این هش‌ها باید برای replay **قدیمی** حفظ شوند؛ تغییر قوانین **جدید** فقط نسخه‌دار و مستند مجاز است.

### WS-01 / CHAT-01

- WSConnection با socket آزمایشی، frame بایت `81 05` + `hello` بدون mask → onMessage('hello')؛ `80 05` + payload → continuation یتیم هم تحویل می‌شود.
- آغاز text با FIN=0 و text دیگر FIN=1 جای قبلی را بی‌خطا می‌گیرد؛ ping با FIN=0 پاسخ pong دارد.
- JSON نمونه‌ها در `before/websocket.json`؛ متن واقعی فهرست فیلتر فقط در social.json نگه داشته می‌شود. regressionها از همان داده می‌خوانند.

### SHD-01

روی اجرای low، به medium تغییر دهید؛ World.update با dtهای 0.1،0.1،1.6 و render. sun position در هر سه عوض می‌شود؛ dirty سراسری فقط اول true است و matrix در refresh بعدی ثابت می‌ماند. `before/lifecycle.json` شاهد دقیق است. رفع باید dirty هر دو سطح و fitting/snapping را پوشش دهد.

## چیزهایی که این ممیزی ثابت نمی‌کند

FPS/VRAM/حرارت/باتری گوشی واقعی، نصب PWA در iOS/Android، safe-area واقعی notch، صدای واقعی دستگاه، مجوز مستقل ترجمه و تلاوت، بازبینی دینی واجد صلاحیت، و همهٔ بارهای غیرعادی تولید. هیچ هدف ۶۰fps یا کاهش حافظهٔ GPU در این سند به‌عنوان نتیجهٔ دستگاه واقعی ادعا نشده است.


## دور اول — تست‌محور امنیت

- SEC-01/SEC-02، WS-01/WS-02، CHAT-01: اصلاح در حال انجام؛ `SECURITY-GREEN.txt` **۴۳ تست سبز** از جمله ۱۰۲۴ ورودی fuzz قطعی و همهٔ مرزهای TCP split است. فایل‌های `REGRESSIONS-RED.txt`، `QURAN-RED.txt` و `SERVER-RED.txt` شاهد شکست قبل از اصلاح‌اند.
- WS-02 با آزمون deadline/مجموع fragments/backpressure/cap اتصال-IP تأیید شد؛ WS-03 در جدول بالا صرفاً رد پذیرش opcode 3/oversize است. عنوان «WS-03» در نام مجموعهٔ تست پذیرش اتصال به همین شمارهٔ ممیزی اشاره نمی‌کند.
- BTL-02 اصلاح نتیجهٔ replay لازم دارد. **رد شد**: فرض باقی‌ماندن دائم پنل مخفی پس از withdraw؛ smoke اصلاح‌شده نشان داد گزارش پس از اعمال فرمان در تیک بعد دوباره ظاهر می‌شود. خطای اول fixture پنل (train به جای startTraining) از شمار باگ‌ها کنار گذاشته شد.
- **UI-02 / P1 تأیید**: BarracksPanel با شروع آموزش خطای `entry.row.style` می‌دهد؛ row هنگام ایجاد صف در رکورد ذخیره نشده است. `PANELS-RED.txt` خطای واقعی و overlap کنترل‌های replay را ثبت می‌کند.
- برای آزمون امنیت پذیرش اتصال، نسخهٔ اصلی `server.js` موقتاً از commit پایه خوانده شد، تست‌ها اجرا و فایل اصلاح‌شده بازگردانده شد؛ آزمون روی HTTP/WS نمایشی فرضی نیست.
- reviewed دیتاست واقعی تغییر نکرده است. checksum تمام بایت‌ها در تنظیمات pin شده؛ جایگزین مسیر فقط relative + pin قبلی اپراتور، همراه schema، سقف بایت و deadline مطلق پذیرفته می‌شود.


## دور دوم — نبرد، پنل‌ها و lifecycle

- BTL-01: قاعدهٔ `attacker.columnExit` در battle.json، snapshot در scenario **v2**، record **v2** و migration ذخیره **۶→۷**. اولویت دفاعی تمام‌شده + کل موج spawn شده + نبود رزمندهٔ مدافع + HP باقیمانده ≤۴۰٪ اولیه، پس از ۴۰ تیک مهلت، مهاجمان را به FSM عقب‌نشینی/محو می‌برد؛ هیچ استثنای seed یا ساعت در منطق نیست.
- seed 33 نسخهٔ جدید: exit=1192، victory=1270 (**63.5s**)، فقط **۳** ضربه پس از برج به‌جای ۲۰۴؛ town HP=2768. stateHash=**445231351** و eventHash=**1524205022** تغییر عمدیِ نسخهٔ جدید است. ضبط v1 همچنان stateHash=1226110089 / eventHash=214625525 / tick=3000 و تمام checkpointهای خود را عیناً بازپخش می‌کند.
- ماتریس ۴۲ سناریو × دو نسخه (با verify ضبطِ هر ۸۴ اجرا): v1=۲۲ پیروزی/۱۸ timeout/۲ شکست؛ v2=۲۹ پیروزی/۱۲ timeout/۱ شکست. timeoutهای باقی‌مانده به‌خودیِ خود خطای فنی نیستند: سناریوی قوی یا هدف دفاعی زنده شامل قاعدهٔ ستون ضعیف نمی‌شود. جزئیات برای بررسی توازن انسانی در `after/battle-matrix.json` ثبت شده است.
- BTL-02/UI-02: overlap کنترل‌ها پس از replay و row مفقود پادگان رفع شد. **BTL-03/P1** تازه تأیید/رفع: دکمهٔ replay روی گزارش session را نمی‌بست و busy می‌داد؛ `_settle` هم به `session.record` به جای `session.recorded` می‌خواند و یک replay درست را در پایان نادرست می‌نامید. شاهد red→green: `PANELS-RED.txt` / `BATTLE-PANELS-GREEN.txt`.
- LOOP-01/LOOP-02/GPU-02/dirty بخش SHD-01 رفع شدند؛ **۵ تست red→green**. jitter واقعی مصنوعی ۶۰ callback پیش از اصلاح فقط ۳۰ render، پس از آن ۶۰ render دارد؛ ۳۰ سقف عمدی batterySaver باقی است. hidden/context-lost زنجیرهٔ rAF را قطع می‌کنند. FPS آماری از delta واقعی (نه delta محدود شبیه‌ساز) خوانده می‌شود.
- Skeletonهای هر clone آزاد می‌شوند، بدون dispose هندسه/متریال مشترک؛ GLTF نامعتبر پس از parse آزاد می‌شود. اندازهٔ نشت VRAM روی سخت‌افزار همچنان اندازه‌گیری‌نشده است.
- در این مرحله `npm test` = **۱۱۲ self-check + ۱۱۷ unit** سبز؛ smoke قدیمی و smokeهای مستقل Battle/Barracks سبز. Fitting/snapping کامل سایه و draw-call batching هنوز مرحلهٔ بعدند.


## دور سوم — بودجهٔ رندر و بار اولیه

- PERF-01: root منطقی/دیداری هر ساختمان حفظ شد، ولی جزءهای هم‌متریال در template مصرف‌شونده merge و نمونه‌های تکراری InstancedMesh شدند. ownership هندسه در batch، متریال/texture در factory و matrix هر entity در view است؛ game هیچ root نمی‌گیرد. تست قبل **۳۴۲ Mesh** در fixture، بعد داخل بودجه؛ WebGL مقایسهٔ یکسان ۳۰ ساختمان: **305→50 calls** و **306/348→51 geometries**. قبل/بعد در `01-stability` و `02-batching`؛ پیکسل‌ها عمداً همان ظاهر قبلی‌اند. همهٔ سطوح کیفیت و preview/scaffold/tilt آسیب حفظ شدند.
- رزولوشن با frame interval واقعی، EMA، hysteresis و cooldown، در محدودهٔ هر کیفیت تنظیم می‌شود؛ quality و batterySaver مستقل‌اند. این کنترل هیچ tick/seed/hash نبرد را تغییر نمی‌دهد. شمارندهٔ HUD هم delta واقعی می‌خواند، نه dt محدود موتور. FPS نرم‌افزاری پایین دیگر به‌اشتباه حداقل ۱۰ گزارش نمی‌شود.
- آرایش سوم تأییدشده (seed 79) **دو برج در (15,15)/(23,23)** دارد، نه آرایش seed 33. ماتریس اصلاح‌شده **۴۳ کیس × دو نسخه، ۸۶ verify**: v1=۲۲ victory/۱۹ timeout/۲ defeat؛ v2=۳۰ victory/۱۲ timeout/۱ defeat. هر سه reproduction اصلی در regression مستقل، hash قدیمی برابر و پایان جدید victory دارند.
- بار اولیه با traversal همهٔ static imports از manifest اندازه‌گیری می‌شود، نه صرفاً entry کوچک. در این مرحله **199.20 kB gzip** (entry + three)، **۳۹٫۳۰٪** کمتر از مبنای واقعی 328.16، و **۳۰٫۹۸٪** کمتر از عدد تاریخی 288.6؛ هدف ≤202.02 برآورده شد. اندازهٔ تمام lazy chunkها جدا در `after/bundle.json` است؛ کاهش مجموعِ کد ادعا نمی‌شود.
- battle/study/settings/jamaat/campaign/guide/audio فقط با factory تک‌پرواز load می‌شوند؛ late result پس از dispose نمی‌تواند UI/GPU دوباره بسازد. آموزش/مأموریت ذخیره‌شده پیش از bootstrap logic خود را install می‌کنند تا progress از بین نرود. Game/Config eager برای embedder/تست سازگار مانده‌اند و browser از Runtime بدون import سنگین استفاده می‌کند.
- تنها منبع رشته‌ها `strings.fa.json` است؛ plugin یک زیرمجموعهٔ boot تولید می‌کند و dictionary کامل پیش از پنل lazy نصب می‌شود. reviewed یا متون درس تغییر نکردند. Terser امن و فشرده‌سازی comment/whitespace GLSL بدون تغییر operator/preprocessor به‌کار رفت؛ کامپایل واقعی WebGL هر سه کیفیت و smoke سبز بود.
- در این مرحله **۱۱۲ self-check + ۱۲۸ unit**، smoke، build، PWA (۲۷ فایل) و bundle gate سبزند. ماتریس کامل FPS/heap پس از نهایی شدن مرحلهٔ سایه/گرافیک دوباره اجرا می‌شود؛ اعداد میانگین جدید هنوز ادعا نشده‌اند.


## دور چهارم — گرافیک سنجش‌پذیر و انتشار ایمن

- SHD-01: علاوه بر dirty دو سطح، visible caster volume با frustum دوربین clip، extentها bucket، centre نور روی texel snap و UP در zenith بدون singularity می‌شود. آزمون‌های sub-texel / fit / zenith سبزند. WebGL در `after/lifecycle.json`: dirty=true→matrixChange=true، تیک بدون refresh=false→false، refresh بعدی=true→true. absence of shimmer روی گوشی واقعی هنوز اندازه‌گیری‌نشده است.
- ۱۰ چرخهٔ پنل/نبرد procedural: **۱۳ geometry / ۴ texture / ۱۱ program** ثابت؛ terminal geometry/texture **۰/۰** و counter program **۶** (کَش داخلی/نامرتبط با اثبات VRAM). context از دست داده می‌شود؛ هیچ ادعای VRAM صفر روی سخت‌افزار نمی‌شود.
- اصول تصویر/محتوا حفظ شدند: سرهای faceless، guard/archer/healer/breaker با عضو/ابزار متمایز و **۳۲۴–۴۶۸ triangle** زیر cap JSON؛ shader FSM نمایشی + distance/frame-budget LOD؛ داده و hash نبرد از این shader بی‌خبرند. GLB موجود اختیاری/opt-in مانده، default procedural است.
- UI فونت OFL و SVG دارد. Font regression واقعی landscape/maxfont شناسایی/رفع شد؛ چهار شکست 360×640 مربوط به **پوشش جدیدِ بودجهٔ ۸٫۵٪ dock** بودند، نه شاهد overflow قدیمی. `FONT-HUD-RED.txt`→`after/hud.txt`: **۲۰۱/۲۰۱**. safe-area مصنوعی (۴ اندازه × دو فونت) **۸/۸**؛ notch واقعی اندازه‌گیری‌نشده.
- **GPU-03/P3:** mergePainted با input indexed قرارداد consumed را نقض می‌کرد؛ تست red→green و dispose input اضافه شد. هندسهٔ مبدأ پیش از render بود، پس مقدار VRAM leak از این تست نتیجه نمی‌شود. سه شکست دیگر UNIT-MODELS-RED هدف هنری جدیدِ حداقل triangle بودند، نه باگ قدیمی.
- **PWA-01/P2:** skipWaiting خودکار می‌توانست release آفلاین فعال را حین اجرا عوض کند. install دیگر آن را صدا نمی‌زند؛ UI رضایت + durable save دارد. تست UI ثابت می‌کند قبل از resolve ذخیره نه SKIP_WAITING و نه reload انجام می‌شود. خطای IDB/حافظهٔ موقت update را متوقف می‌کند (`SAVE-DURABILITY-RED.txt`→green).
- SHA فایل قرآن، reviewed و متن هیچ‌کدام تغییر نکردند. Brotli واقعی از HTTP: **3,181,959→541,769 bytes**، **۸۲٫۹۷٪** کمتر، decompress برابر بایت‌به‌بایت و همان checksum؛ نه کاهش اندازهٔ دادهٔ decode‌شده.


## تعارض واقعیِ کارایی و هنر

اولین ماتریس کامل پس از graphics در `docs/upgrade/iterations/graphics-first-pass.json` نگه داشته شد: با وجود افت calls، high battle در SwiftShader از میانگین ۳٫۴۰ به ۱٫۷۸fps افت کرد؛ عدد نامطلوب حذف/مخفی نمی‌شود. برای رعایت اولویت کارایی، mapهای normal/roughness هنگام افت scale governor bypass می‌شوند و واکنش downscale سریع‌تر شد. **GOV-02/P2 تأیید**: hysteresis قبلی بازیابی را به interval <۱۳ms وابسته می‌کرد، در حالی که cap واقعی ۶۰Hz حداقل ~۱۶٫۶۷ms دارد؛ `GOVERNOR-RED.txt` قبل از اصلاح شکست واقعیِ عدم بازیابی را ثبت کرد. threshold بازیابیِ قابل‌دستیابی و تست ۶۰Hz اضافه شد. ماتریس دوم گزارش نهایی است، نه شاهد رسیدن گوشی به ۶۰fps.

ابزار performance پس از ثبت هر ۱۸ case، در چهار screenshot تکمیلی HUD به دلیل `ftueGuide=null` (lazy) شکست خورد؛ این **خطای harness** بود، نه بازی. optional chaining اصلاح شد؛ اعداد ۱۸ case اول invalid نیستند.


## نتیجهٔ اندازه‌گیری نهایی

ماتریس دوم کامل (۱۸ case + چهار screenshot HUD، exit 0) روی commit اجرایی `3db8fe0` ثبت شد. بیشینه **۷۷ calls / ۳۸٬۷۸۸ triangles**، JS اولیه **۲۰۱٫۶۵ kB gzip** زیر ۲۰۲٫۰۲. برای نمونهٔ CPU1×/low: empty میانگین۵٫۵۳→۱۷٫۵۴، city۳۰=۱۰٫۳۵→۱۴٫۵۰، battle۳۰=۶٫۶۳→۷٫۸۷fps؛ این اعداد **SwiftShader، با DPR تطبیقی** هستند و معادل گوشی نیستند. p1 بعضی حالت‌ها و بعضی CPU4×ها بدتر شدند؛ جدول کامل و افت‌ها در `docs/upgrade/REPORT.md` است، نه فقط بهترین عدد.

درگاه نهایی: **۱۱۲ self-check + ۱۴۲ unit**، smoke، build، PWA، bundle سبز؛ HUD **۲۰۱/۲۰۱** و safe-area مصنوعی **۸/۸**. qualified human review، phone FPS60/VRAM/thermal/battery/install همچنان **اندازه‌گیری‌نشده**. advanced terrain/foam/grass/atlas، high postprocess، citizens و FX/growth/floating-number کامل، در این دور **کامل نشده‌اند** و صریحاً در گزارش outstanding هستند. main و هیچ PRی merge نشده‌اند.
