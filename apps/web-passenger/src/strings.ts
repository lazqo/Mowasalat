/** Every word the passenger reads. Kept in one place so it can be reviewed. */
export const Ar = {
  appName: "مواصلات",
  whereTo: "وين رايح؟",
  search: "دوّر على المكان",
  noPlace: "ما لقينا هالمكان",

  findingYou: "جاري تحديد موقعك",
  needLocation: "لازم نعرف وين إنت عشان نجيب لك الباص",
  locationRefused: "ما قدرنا نحدد موقعك. افتح الموقع من إعدادات المتصفح وجرّب كمان مرة.",
  retry: "جرّب كمان مرة",

  noLineHere: "ما في خط من هون لهالمكان",
  noBusNow: "ما في باص شغال هلق",
  departsFrom: "الباصات بتطلع من",
  imWaiting: "أنا مستني هون",
  iBoarded: "ركبت",
  cancel: "إلغاء",
  confirmCancel: "متأكد إنك بدك تلغي؟",
  yesCancel: "نعم، ألغي",
  notYet: "لا",

  waitingForBus: "الباص جاي",
  driverSeesYou: "السواق شايف إنك مستني",
  requestExpired: "انتهى الطلب. جرّب مرة ثانية.",
  boardedThanks: "رحلة سعيدة",
  cancelled: "تم الإلغاء",
  again: "من جديد",

  reconnecting: "جاري إعادة الاتصال…",
  offline: "ما في إنترنت",
  loading: "لحظة…",
  loadFailed: "ما قدرنا نوصل للخدمة",

  you: "إنت",

  /**
   * Required, not decorative. The corridors are derived from OpenStreetMap and
   * stored, which the ODbL permits on condition of attribution — unlike the
   * commercial routing APIs, which forbid storing the result at all.
   */
  mapCredit: "بيانات الطرق من OpenStreetMap",
  provisional: "الخط لسا تحت التجربة",

  /** "بضل ١٢ دقيقة" */
  minutesLeft: (minutes: number) => `بضل ${minutes} دقيقة`,
};

/**
 * Distance as a person would say it. Metres below a kilometre, because "٠٫٤
 * كم" is a number to decode and "٤٠٠ متر" is a distance you can see.
 */
export function humaniseDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 50) * 50} متر`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} كم` : `${Math.round(km)} كم`;
}
