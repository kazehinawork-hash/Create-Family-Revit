using System;
using System.IO;
using System.Linq;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace FamilyAgent.Addin
{
    /// <summary>
    /// Application chạy tự động khi Revit khởi động.
    /// Tự động dò tìm file spec.json trong thư mục Portable, dựng Native Family,
    /// MOVE file .rfa về thư mục Portable và tự động đóng Revit (Zero-click).
    /// </summary>
    public sealed class PortableAutoApp : IExternalApplication
    {
        private static UIControlledApplication _app;

        public Result OnStartup(UIControlledApplication application)
        {
            _app = application;
            // Đăng ký sự kiện Idling: ngay khi Revit khởi động và sẵn sàng, tự động thực thi build
            application.Idling += OnRevitIdling;
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            application.Idling -= OnRevitIdling;
            return Result.Succeeded;
        }

        private static void OnRevitIdling(object sender, IdlingEventArgs e)
        {
            // Chỉ chạy duy nhất 1 lần khi Revit vừa mở xong
            _app.Idling -= OnRevitIdling;

            var uiApp = sender as UIApplication;
            if (uiApp == null) return;

            var addinDir = Path.GetDirectoryName(typeof(PortableAutoApp).Assembly.Location) ?? AppDomain.CurrentDomain.BaseDirectory;

            // Ưu tiên đọc đường dẫn file spec cụ thể từ biến môi trường FAMILY_AGENT_SPEC nếu có
            string specFile = Environment.GetEnvironmentVariable("FAMILY_AGENT_SPEC");
            if (string.IsNullOrEmpty(specFile) || !File.Exists(specFile))
            {
                // Nếu không có biến môi trường hoặc file chỉ định không tồn tại, tìm file spec trong cùng thư mục
                specFile = Directory.GetFiles(addinDir, "*spec*.json")
                    .Concat(Directory.GetFiles(addinDir, "*.json"))
                    .FirstOrDefault();
            }

            if (specFile == null || !File.Exists(specFile))
            {
                var errorLog = Path.Combine(addinDir, "build_error.log");
                File.WriteAllText(errorLog, "Không tìm thấy file spec.json trong thư mục: " + addinDir);
                return;
            }

            try
            {
                // Cấu hình thư mục lưu file .rfa trực tiếp tại thư mục đích nếu có (FAMILY_AGENT_OUT) hoặc thư mục addin
                var configuredOut = Environment.GetEnvironmentVariable("FAMILY_AGENT_OUT");
                var targetOutDir = (!string.IsNullOrEmpty(configuredOut) && Directory.Exists(configuredOut))
                    ? configuredOut
                    : addinDir;
                Environment.SetEnvironmentVariable("FAMILY_AGENT_OUT", targetOutDir);

                var json = File.ReadAllText(specFile);
                var result = FamilyBuilder.Build(uiApp.Application, json);

                var logPath = Path.Combine(targetOutDir, "build_result.txt");
                if (result.Ok)
                {
                    var rfaPath = result.Path;
                    File.WriteAllText(
                        logPath,
                        $"SUCCESS\nPath: {rfaPath}\nRevitVersion: {result.RevitVersion}" +
                        (result.Warnings.Count > 0
                            ? "\nWarnings:\n" + string.Join("\n", result.Warnings)
                            : ""));
                }
                else
                {
                    File.WriteAllText(logPath, $"FAILED\nError: {result.Error}\nWarnings:\n" + string.Join("\n", result.Warnings));
                }
            }
            catch (Exception ex)
            {
                var targetOutDir = Environment.GetEnvironmentVariable("FAMILY_AGENT_OUT") ?? addinDir;
                var logPath = Path.Combine(targetOutDir, "build_crash.log");
                File.WriteAllText(logPath, ex.ToString());
            }
            finally
            {
                // Sau khi dựng xong, nếu cờ AUTO_EXIT được bật (chạy từ .bat), tự động đóng Revit
                var autoExit = Environment.GetEnvironmentVariable("FAMILY_AGENT_AUTO_EXIT");
                if (string.Equals(autoExit, "1", StringComparison.OrdinalIgnoreCase))
                {
                    // Đóng Revit an toàn
                    try
                    {
                        var exitCommandId = RevitCommandId.LookupPostableCommandId(PostableCommand.ExitRevit);
                        if (exitCommandId != null && uiApp.CanPostCommand(exitCommandId))
                        {
                            uiApp.PostCommand(exitCommandId);
                        }
                    }
                    catch { }
                }
            }
        }
    }
}

